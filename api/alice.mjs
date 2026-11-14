
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Alice GPT webhook is running");
  }

  const question = req.body?.request?.original_utterance || "";

  return res.status(200).json({
    version: "1.0",
    response: {
      text: `Проверка Vercel. Вы спросили: ${question || "ничего"}`,
      end_session: false
    },
    session_state: {}
  });
}
