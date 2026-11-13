"""옵저버(Observer) 패턴 — 사건 버스.

상태가 바뀌면 이벤트를 발행하고, 구독자들이 각자 일을 한다.
  AuditSubscriber   : 누가·언제·무엇을 결정했는지 감사 로그
  (서비스가 구독)   : 작업 생성·연계 건 갱신·채널 발송
발행자는 구독자를 모른다 → 새 부서(구독자)를 붙여도 판단 코드는 그대로.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Callable

Handler = Callable[[str, dict], None]


class EventBus:
    def __init__(self) -> None:
        self._subs: dict[str, list[Handler]] = defaultdict(list)

    def subscribe(self, topic: str, h: Handler) -> None:
        self._subs[topic].append(h)

    def publish(self, topic: str, payload: dict) -> None:
        for h in self._subs.get(topic, []) + self._subs.get("*", []):
            h(topic, payload)
