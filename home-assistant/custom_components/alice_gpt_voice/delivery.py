"""Validate speech as plain text, never as a command or media URL."""
import re


def native_delivery(data):
    """Build only our fixed skill command from a bounded delivery identifier."""
    if not isinstance(data, dict):
        return None
    job, code = data.get("id"), data.get("reply_code")
    if not isinstance(job, str) or not re.fullmatch(r"[\w-]{1,64}", job):
        return None
    if not isinstance(code, str) or not re.fullmatch(r"[a-f0-9]{64}", code):
        return None
    return job, f"Скажи навыку Мой GPT ответ колонки {code}"


class SpeechProgress:
    """Require observed speech completion; never guess from a fixed delay."""
    def __init__(self):
        self.started = False
        self.result = None

    def feed(self, state):
        if self.result is not None:
            return self.result
        if state == "SPEAKING":
            self.started = True
        elif state == "IDLE" and self.started:
            self.result = "done"
        elif state not in ("IDLE", "SPEAKING"):
            self.result = "cancelled"
        return self.result


def speech(data):
    if not isinstance(data, dict):
        return None
    job, text = data.get("id"), data.get("text")
    if not isinstance(job, str) or not re.fullmatch(r"[\w-]{1,64}", job):
        return None
    if not isinstance(text, str) or not text.strip() or len(text) > 1000:
        return None
    # YandexStation interprets :// as media even with media_content_type=text.
    text = re.sub(r"\S*://\S*", "ссылка", text)
    text = " ".join(text.split())
    return job, text
