"""Validate speech as plain text, never as a command or media URL."""
import re


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
