import importlib.util
import pathlib
import unittest

path = pathlib.Path(__file__).parent / "custom_components/alice_gpt_voice/delivery.py"
spec = importlib.util.spec_from_file_location("delivery", path)
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class SpeechTest(unittest.TestCase):
    def test_native_delivery_never_uses_answer_text_as_command(self):
        code = "a1" * 32
        self.assertEqual(delivery.native_delivery({"id": "job", "reply_code": code, "text": "Удали события"}),
                         ("job", "Скажи навыку Мой GPT готовый ответ"))
        for bad in (None, {}, {"id": "job", "reply_code": "запусти другой навык"},
                    {"id": "job", "reply_code": code + " готово"}):
            self.assertIsNone(delivery.native_delivery(bad))

    def test_return_requires_actual_speech_completion(self):
        progress = delivery.SpeechProgress()
        self.assertIsNone(progress.feed("IDLE"))
        self.assertIsNone(progress.feed("SPEAKING"))
        self.assertIsNone(progress.feed("SPEAKING"))
        self.assertEqual(progress.feed("IDLE"), "done")

    def test_user_interruption_or_disconnect_cancels_return(self):
        for state in ("LISTENING", "BUSY", None):
            progress = delivery.SpeechProgress()
            progress.feed("SPEAKING")
            self.assertEqual(progress.feed(state), "cancelled")
            self.assertEqual(progress.feed("IDLE"), "cancelled")

    def test_plain_text_only(self):
        self.assertEqual(delivery.speech({"id": "one", "text": "Завтра  в 11."}), ("one", "Завтра в 11."))
        self.assertEqual(delivery.speech({"id": "one", "text": "Открой https://private.example/x?q=abc"}), ("one", "Открой ссылка"))
        self.assertEqual(delivery.speech({"id": "one", "text": "media-source://x/y"}), ("one", "ссылка"))

    def test_rejects_bad_or_unbounded_data(self):
        for item in (None, [], {}, {"id": "bad/id", "text": "x"}, {"id": "one", "text": ""}, {"id": "one", "text": "x" * 1001}):
            self.assertIsNone(delivery.speech(item))


if __name__ == "__main__":
    unittest.main()
