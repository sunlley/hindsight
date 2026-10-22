"""The control plane page's sign-in: password hashing, session tokens and a throttle on failed attempts.

One admin account, kept on this side so the page needs no files or environment variables of its own. The
account's password is stored as a scrypt hash; a session is a signed, expiring token the control plane keeps
in a cookie and checks back against the API.
"""

import base64
import hashlib
import hmac
import secrets
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass

SESSION_TTL_SECONDS = 24 * 60 * 60

# scrypt cost: n=2**14, r=8 is the interactive-login baseline (~16 MB, tens of ms).
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def hash_password(password: str) -> str:
    """``scrypt$<n>$<r>$<p>$<salt>$<hash>``: everything needed to check a password later is in the string."""
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=32)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, expected = stored.split("$")
        if scheme != "scrypt":
            return False
        digest = hashlib.scrypt(password.encode(), salt=_unb64(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(digest, _unb64(expected))
    except (ValueError, TypeError):
        return False


# Checked when the username is unknown, so a wrong username costs as much time as a wrong password and
# the response time does not tell a caller which usernames exist.
_UNKNOWN_USER_HASH = hash_password(secrets.token_hex(16))


def verify_login(password: str, username: str, account_username: str | None, stored_hash: str | None) -> bool:
    """Whether these credentials match the account, taking the same time whichever part is wrong."""
    password_ok = verify_password(password, stored_hash or _UNKNOWN_USER_HASH)
    username_ok = account_username is not None and hmac.compare_digest(username.encode(), account_username.encode())
    return password_ok and username_ok and stored_hash is not None


@dataclass(frozen=True)
class SessionToken:
    token: str
    expires_at: float


def _sign(secret: str, payload: str) -> str:
    return _b64(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())


def issue_session_token(secret: str, username: str, now: float | None = None) -> SessionToken:
    """``<expiry>.<username>.<signature>``, with the username base64 so it cannot contain a separator."""
    # Wall-clock on purpose: the expiry is a point in real time that the verifier checks later.
    expires_at = (time.time() if now is None else now) + SESSION_TTL_SECONDS  # noqa: TID251
    payload = f"{int(expires_at)}.{_b64(username.encode())}"
    return SessionToken(token=f"{payload}.{_sign(secret, payload)}", expires_at=expires_at)


def verify_session_token(secret: str | None, token: str, now: float | None = None) -> str | None:
    """The username the token was issued to, or ``None`` if it is forged, expired or malformed."""
    if not secret:
        return None
    try:
        expiry, username_b64, signature = token.split(".")
        if not hmac.compare_digest(_sign(secret, f"{expiry}.{username_b64}"), signature):
            return None
        if int(expiry) < (time.time() if now is None else now):  # noqa: TID251 (real-time expiry, see issue_session_token)
            return None
        return _unb64(username_b64).decode()
    except (ValueError, TypeError):
        return None


class LoginThrottle:
    """Refuses further attempts from a caller after too many recent failures.

    In memory and per process: it slows guessing, it is not a lockout list that must survive a restart.
    A ``threading.Lock`` guards the map (await-free sections only), as it is reached from whichever loop
    serves the request.
    """

    def __init__(self, max_failures: int = 5, window_seconds: float = 300.0) -> None:
        self._max_failures = max_failures
        self._window = window_seconds
        self._failures: defaultdict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def seconds_until_allowed(self, caller: str, now: float | None = None) -> float:
        """0 when the caller may try; otherwise how long until its oldest recent failure ages out."""
        now = time.monotonic() if now is None else now
        with self._lock:
            recent = self._prune(caller, now)
            if len(recent) < self._max_failures:
                return 0.0
            return max(0.0, recent[0] + self._window - now)

    def record_failure(self, caller: str, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        with self._lock:
            self._prune(caller, now).append(now)

    def record_success(self, caller: str) -> None:
        with self._lock:
            self._failures.pop(caller, None)

    def _prune(self, caller: str, now: float) -> deque[float]:
        # Every caller ever seen would stay in the map otherwise; a caller whose failures have all aged out is
        # dropped, so the map holds only the last window's failures.
        for stale in [c for c, times in self._failures.items() if not times or times[-1] + self._window <= now]:
            del self._failures[stale]
        return self._failures[caller]
