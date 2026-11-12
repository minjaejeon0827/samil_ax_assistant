import { useEffect, useRef, useState } from "react";
import { trapTab } from "./bits";

/** 로그인 모드(AUTH_MODE=jwt) 서버에 연결했을 때만 뜬다 — 역할은 로그인한 계정이 정한다(J-01). */
export function LoginDialog({ onLogin, ssoLabel, onSso }: { onLogin: (user: string, password: string) => Promise<void>; ssoLabel?: string | null; onSso?: () => Promise<void> }) {
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try { await onLogin(user.trim(), password); } catch (err) { setError((err as Error).message); setPassword(""); } finally { setBusy(false); }
  };
  return (
    <div className="dialog-back">
      <form className="dialog login" role="dialog" aria-modal="true" aria-labelledby="login-title" onSubmit={submit} onKeyDown={(e) => trapTab(e)}>
        <h2 id="login-title">서버 모드 로그인</h2>
        <p className="hint">이 서버는 로그인한 계정의 역할로만 결재합니다. 계정은 관리자에게 받으세요.</p>
        <label>아이디<input ref={first} data-testid="login-user" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={user} onChange={(e) => setUser(e.target.value)} required /></label>
        <label>비밀번호<input data-testid="login-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="alert seal" role="alert">{error}</p>}
        <button type="submit" data-testid="login-submit" disabled={busy}>{busy ? "확인 중…" : "로그인"}</button>
        {/* v1.21(§15-1): 사내 SSO(OIDC) — 서버에 설정돼 있을 때만 */}
        {ssoLabel && onSso && <button type="button" className="ghost" data-testid="login-sso" disabled={busy}
          onClick={async () => { setBusy(true); setError(""); try { await onSso(); } catch (err) { setError((err as Error).message); setBusy(false); } }}>{ssoLabel}로 로그인</button>}
      </form>
    </div>
  );
}

/** v1.21(§15-1): 비밀번호 변경(로컬 계정). 바꾸면 다른 기기의 로그인도 모두 끊긴다. */
export function PasswordDialog({ onChange, onClose }: { onChange: (current: string, next: string) => Promise<void>; onClose: () => void }) {
  const [cur, setCur] = useState(""); const [next, setNext] = useState(""); const [again, setAgain] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== again) { setError("새 비밀번호 두 칸이 다릅니다."); return; }
    setBusy(true); setError("");
    try { await onChange(cur, next); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="dialog-back">
      <form className="dialog login" role="dialog" aria-modal="true" aria-labelledby="pw-title" onSubmit={submit} onKeyDown={(e) => { trapTab(e); if (e.key === "Escape") onClose(); }}>
        <h2 id="pw-title">비밀번호 변경</h2>
        <p className="hint">10자 이상, 영문·숫자·기호 중 두 종류 이상. 바꾸면 다른 기기의 로그인은 모두 끊기고 이 화면은 새로 로그인됩니다.</p>
        <label>현재 비밀번호<input ref={first} data-testid="pw-current" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></label>
        <label>새 비밀번호<input data-testid="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required /></label>
        <label>새 비밀번호 확인<input data-testid="pw-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required /></label>
        {error && <p className="alert seal" role="alert">{error}</p>}
        <div className="row"><button type="submit" data-testid="pw-submit" disabled={busy}>{busy ? "바꾸는 중…" : "바꾸기"}</button><button type="button" className="ghost" onClick={onClose}>닫기</button></div>
      </form>
    </div>
  );
}
