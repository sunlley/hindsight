"""The control plane page's sign-in primitives: password hashing, session tokens, the failure throttle."""

import pytest

from hindsight_api.admin_login import (
    SESSION_TTL_SECONDS,
    LoginThrottle,
    hash_password,
    issue_session_token,
    verify_login,
    verify_password,
    verify_session_token,
)

SECRET = "s" * 64


def test_a_password_checks_out_against_its_own_hash_only():
    stored = hash_password("correct horse")
    assert stored.startswith("scrypt$")
    assert "correct horse" not in stored
    assert verify_password("correct horse", stored)
    assert not verify_password("correct horsf", stored)
    assert not verify_password("", stored)


def test_hashing_salts_every_password():
    assert hash_password("same") != hash_password("same")


@pytest.mark.parametrize("stored", ["", "plaintext", "scrypt$1$2", "md5$1$2$3$4$5", "scrypt$x$y$z$a$b"])
def test_a_malformed_stored_hash_never_verifies(stored):
    assert not verify_password("anything", stored)


def test_login_needs_the_right_username_and_password():
    stored = hash_password("pw-12345678")
    assert verify_login("pw-12345678", "admin", "admin", stored)
    assert not verify_login("pw-12345678", "Admin", "admin", stored)
    assert not verify_login("wrong-password", "admin", "admin", stored)
    # No account at all: nothing can match, whatever is sent.
    assert not verify_login("pw-12345678", "admin", None, None)


def test_a_session_token_names_who_it_was_issued_to():
    token = issue_session_token(SECRET, "ada.lovelace@example", now=1_000_000.0)
    assert token.expires_at == 1_000_000.0 + SESSION_TTL_SECONDS
    assert verify_session_token(SECRET, token.token, now=1_000_100.0) == "ada.lovelace@example"


def test_a_session_token_is_refused_when_forged_expired_or_from_another_secret():
    token = issue_session_token(SECRET, "admin", now=1_000_000.0).token
    expiry, name, signature = token.split(".")

    assert verify_session_token(SECRET, token, now=1_000_000.0 + SESSION_TTL_SECONDS + 1) is None
    assert verify_session_token("another-secret", token, now=1_000_100.0) is None
    assert verify_session_token(None, token, now=1_000_100.0) is None
    # Moving the expiry or the name without the secret breaks the signature.
    assert verify_session_token(SECRET, f"{int(expiry) + 99999}.{name}.{signature}", now=1_000_100.0) is None
    assert verify_session_token(SECRET, f"{expiry}.{name[:-1]}A.{signature}", now=1_000_100.0) is None
    for garbage in ("", "a.b", "a.b.c.d", "not a token"):
        assert verify_session_token(SECRET, garbage, now=1_000_100.0) is None


def test_the_throttle_stops_a_caller_after_enough_failures_and_lets_it_back_in():
    throttle = LoginThrottle(max_failures=3, window_seconds=60)
    for second in range(3):
        assert throttle.seconds_until_allowed("a", now=float(second)) == 0
        throttle.record_failure("a", now=float(second))

    assert throttle.seconds_until_allowed("a", now=3.0) == pytest.approx(57.0)
    # Someone else is not held up by a's failures.
    assert throttle.seconds_until_allowed("b", now=3.0) == 0
    # The oldest failure ages out, which frees one attempt.
    assert throttle.seconds_until_allowed("a", now=61.0) == 0


def test_a_successful_sign_in_clears_the_failures():
    throttle = LoginThrottle(max_failures=2, window_seconds=60)
    throttle.record_failure("a", now=0.0)
    throttle.record_failure("a", now=1.0)
    assert throttle.seconds_until_allowed("a", now=2.0) > 0
    throttle.record_success("a")
    assert throttle.seconds_until_allowed("a", now=2.0) == 0


def test_the_throttle_forgets_callers_whose_failures_have_aged_out():
    throttle = LoginThrottle(max_failures=3, window_seconds=60)
    for n in range(50):
        throttle.record_failure(f"caller-{n}", now=0.0)
    throttle.seconds_until_allowed("someone", now=120.0)
    assert len(throttle._failures) <= 1
