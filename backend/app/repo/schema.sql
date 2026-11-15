-- Aurora 캠페인·계약 판단 데스크 — MySQL 8.x 스키마 (MariaDB 10.6+ 호환)
-- v1.4(4차 E2E): MySQL 8 전용 문법(utf8mb4_0900_ai_ci 정렬, ->> 연산자)을 공통 문법으로 바꿔 MariaDB·MySQL 5.7+에서도 적용되게 함.
--               목록 순서는 밀리초 시각 대신 삽입 순번(seq)으로 보장(같은 밀리초에 여러 건이 기록돼도 순서 유지).
SET NAMES utf8mb4;   -- 생성식의 한글(역할명·'월'·'일')이 깨지지 않게
CREATE DATABASE IF NOT EXISTS aurora_desk DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE aurora_desk;

-- 처리 건(계약 갱신·캠페인 기안·조건 변경). doc: 결정 패키지·상태·이력
CREATE TABLE IF NOT EXISTS cases (
  id VARCHAR(40) PRIMARY KEY,
  seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
  doc JSON NOT NULL,
  version INT NOT NULL DEFAULT 1,
  state VARCHAR(30) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(doc, '$.state'))) STORED,
  created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_state (state)
);
-- 부서 작업(승인 이후 자동 생성)
CREATE TABLE IF NOT EXISTS tasks (
  id VARCHAR(40) PRIMARY KEY, seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE, doc JSON NOT NULL, version INT NOT NULL DEFAULT 1,
  dept VARCHAR(30) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(doc, '$.dept'))) STORED,
  created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), INDEX idx_dept (dept)
);
-- 감사 로그(누가·언제·무엇을) — append only
-- v1.26(AM08): 검색 열은 utf8mb4_bin(글자 그대로) — unicode_ci는 'cafe'로 'Café', 'abc'로 'ＡＢＣ'를 찾아 메모리 저장소와 결과가 달랐다.
-- v1.10(R-02): 검색 대상 = 화면에 보이는 것(역할 한국어명·로그인 사용자·'7월 2일' 표기 추가, 빈 값은 건너뜀). 생성식은 repo/mysql.py search_expr()와 같다(pytest가 확인).
--             v1.9 규칙으로 만든 열은 서버가 기동할 때 새 규칙으로 다시 만든다.
-- v1.9(Q-02): search_text = 검색 대상 필드를 소문자로 이어 붙인 저장 열 → 검색 때 행마다 JSON을 풀지 않음(5만 건 518ms → 수십 ms).
--             이미 만든 DB는 서버가 처음 검색할 때 이 열을 자동으로 추가한다(MySQLRepository._ensure_search_text).
CREATE TABLE IF NOT EXISTS audit (
  id VARCHAR(40) PRIMARY KEY, seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE, doc JSON NOT NULL, version INT NOT NULL DEFAULT 1,
  search_text TEXT COLLATE utf8mb4_bin GENERATED ALWAYS AS (LOWER(CONCAT_WS(' ', NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.detail')), 'null'), ''), NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.actor')), 'null'), ''), CASE JSON_UNQUOTE(JSON_EXTRACT(doc, '$.actor')) WHEN 'MARKETING_TEAM' THEN '마케팅팀' WHEN 'MASIL_CEO' THEN 'Masil 대표' WHEN 'GROUP_CEO' THEN '그룹 CEO/이사회' WHEN 'FINANCE' THEN '재무팀' WHEN 'SCM' THEN 'SCM' WHEN 'CONTRACT_OWNER' THEN '계약 담당' WHEN 'TEST_AURORA' THEN '테스트(Aurora)' WHEN 'AGENCY' THEN '에이전시(모의)' WHEN 'SYSTEM' THEN '시스템' ELSE NULL END, NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.user')), 'null'), ''), NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.case_id')), 'null'), ''), NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.topic')), 'null'), ''), NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.sim_date')), 'null'), ''), CONCAT(CAST(SUBSTRING(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.sim_date')), 6, 2) AS UNSIGNED), '월 ', CAST(SUBSTRING(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.sim_date')), 9, 2) AS UNSIGNED), '일')))) STORED,
  created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3)
);
-- 채널 발송함(MCP 채널 어댑터가 기록하는 모의 이메일·메신저)
CREATE TABLE IF NOT EXISTS outbox (
  id VARCHAR(40) PRIMARY KEY, seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE, doc JSON NOT NULL, version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3)
);
-- 전역 상태(시계·현금 가정·계약 상태·기안 상태)
CREATE TABLE IF NOT EXISTS kv (
  id VARCHAR(40) PRIMARY KEY, seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE, doc JSON NOT NULL, version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- v1.25(25차 AL03 정규화): 업로드한 자동 갱신 계약 기록 — 기존에는 kv 'renewals' 문서 하나(JSON 덩어리)에 모두 담아
--   계약 3,000건이면 15MB 문서를 계약서를 올릴 때마다 통째로 읽고 썼다. 이제 계약 하나 = 행 하나(기존 DB는 서버 기동 때 옮김).
CREATE TABLE IF NOT EXISTS renewals (
  id VARCHAR(40) PRIMARY KEY, seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE, doc JSON NOT NULL, version INT NOT NULL DEFAULT 1,
  status VARCHAR(30) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(doc, '$.status'))) STORED,
  created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), INDEX idx_status (status)
);

-- v1.26(26차 AM05): 계약서 요약 평가 — 기존에는 kv 'summary_feedback' 문서 하나에 모두 담아 평가 2만 건이면 2.9MB를 평가마다
--   통째로 읽고 썼다(평가 1번 193ms). 이제 (건, 사람) 하나 = 행 하나, 건별 조회는 case_id 색인으로(기존 DB는 서버 기동 때 옮김).
CREATE TABLE IF NOT EXISTS feedback (
  id VARCHAR(200) PRIMARY KEY, seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE, doc JSON NOT NULL, version INT NOT NULL DEFAULT 1,
  case_id VARCHAR(40) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(doc, '$.case_id'))) STORED,
  created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), INDEX idx_case (case_id)
);

-- v1.25(25차 AL04): 감사 기록 append only를 DB가 지킨다. 앱 계정으로도 UPDATE·DELETE가 거부되고,
--   '처음부터'(그룹 CEO)만 같은 연결에서 @aurora_reset=1을 켜고 지운다(지운 사실은 새 감사 기록으로 남음).
--   한계: 앱 계정 비밀번호를 가진 사람은 @aurora_reset을 직접 켤 수 있다 → 진짜 위변조 방지는 감사 기록을 별도 보관소로 복제(§14).
DELIMITER //
DROP TRIGGER IF EXISTS audit_no_update //
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit is append-only: 감사 기록은 추가만 할 수 있습니다(고치기·지우기 불가)' //
DROP TRIGGER IF EXISTS audit_no_delete //
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit FOR EACH ROW
BEGIN
  IF COALESCE(@aurora_reset, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit is append-only: 감사 기록은 추가만 할 수 있습니다(고치기·지우기 불가)';
  END IF;
END //
DELIMITER ;

-- v1.25(25차 AL05): 사람이 SQL(DBeaver·Workbench 등)로 운영 데이터를 보는 보기 — JSON을 풀어 열로. 읽기 전용 계정에는 이 보기만 주면 된다.
--   SQL SECURITY INVOKER: 조회하는 사람의 권한으로(만든 계정의 권한에 묶이지 않아, 다른 DB로 복구해도 관리자가 바로 조회 — AL08).
CREATE OR REPLACE SQL SECURITY INVOKER VIEW v_cases AS SELECT id, seq, version, state, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.type')), 'null') AS type, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.kind')), 'null') AS kind, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.title')), 'null') AS title, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.target_id')), 'null') AS target_id, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.approval.approver')), 'null') AS approver, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.approval.decision')), 'null') AS decision, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.approval.decided_by')), 'null') AS decided_by, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.received_on')), 'null') AS received_on, created_at FROM cases;
CREATE OR REPLACE SQL SECURITY INVOKER VIEW v_tasks AS SELECT id, seq, version, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.case_id')), 'null') AS case_id, dept, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.kind')), 'null') AS kind, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.status')), 'null') AS status, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.title')), 'null') AS title, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.due')), 'null') AS due, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.created_on')), 'null') AS created_on, created_at FROM tasks;
CREATE OR REPLACE SQL SECURITY INVOKER VIEW v_audit AS SELECT id, seq, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.sim_date')), 'null') AS sim_date, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.at')), 'null') AS at_time, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.topic')), 'null') AS topic, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.actor')), 'null') AS actor, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.user')), 'null') AS user_name, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.case_id')), 'null') AS case_id, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.detail')), 'null') AS detail FROM audit;
CREATE OR REPLACE SQL SECURITY INVOKER VIEW v_renewals AS SELECT id, seq, version, status, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.terms.counterparty')), 'null') AS counterparty, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.terms.expiry')), 'null') AS expiry, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.terms.auto_renew')), 'null') AS auto_renew, CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.terms.annual_fee_krw')), 'null') AS DECIMAL(20,0)) AS annual_fee_krw, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.terms.currency')), 'null') AS currency, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.terms.notice_deadline')), 'null') AS notice_deadline, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.uploaded_on')), 'null') AS uploaded_on FROM renewals;
