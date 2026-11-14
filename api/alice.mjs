
export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).send("Alice GPT webhook is running");
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const body = req.body || {};
  const question = body.request?.original_utterance?.trim() || "";
  const previousId = body.state?.session?.last_response_id;

  function reply(text, responseId = previousId) {
    return res.status(200).json({
      version: "1.0",
      response: {
        text: text.slice(0, 1000),
        end_session: false
      },
      session_state: responseId
        ? { last_response_id: responseId }
        : {}
    });
  }

  
const command = (body.request?.command || question)
  .toLowerCase()
  .replace(/[«»"“”.,!?]+/g, "")
  .trim();

const exitCommands = [
  "хватит",
  "алиса хватит",
  "стоп",
  "выход",
  "выйти",
  "выйти из навыка",
  "закончить",
  "закрой навык",
  "заверши разговор",
  "пока",
  "алиса вернись"
];

if (exitCommands.includes(command)) {
  return res.status(200).json({
    version: "1.0",
    response: {
      text: "Хорошо, до встречи!",
      end_session: true
    },
    session_state: {}
  });
}

  if (!question) {
    return reply("Привет! Я GPT. О чём поговорим?");
  }

  if (!process.env.OPENAI_API_KEY) {
    return reply("Ошибка: OPENAI_API_KEY не настроен.");
  }

  try {
    const payload = {
      model: "gpt-6-luna",
      reasoning: { effort: "none" },
      instructions:
        "Ты голосовой помощник на базе GPT. " +
        "Отвечай по-русски, естественно и точно. " +
        "Ответы должны быть краткими, обычно 1–3 предложения. " +
        "Не используй Markdown, списки и эмодзи. " +
        "Учитывай контекст предыдущих сообщений.",
      input: question,
      max_output_tokens: 200,
      store: true
    };

    if (previousId) {
      payload.previous_response_id = previousId;
    }

    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(3200)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      const errorCode = data.error?.code || "unknown";
      console.error("OpenAI error:", response.status, errorCode);

      return reply(
        `Ошибка OpenAI HTTP ${response.status}. Код: ${errorCode}`
      );
    }

    const answer = (data.output || [])
      .flatMap(item => item.content || [])
      .filter(item => item.type === "output_text")
      .map(item => item.text)
      .join(" ")
      .trim();

    return reply(
      answer || "Не удалось получить текст ответа.",
      data.id
    );

  } catch (error) {
    console.error("Request error:", error.message);

    if (error.name === "TimeoutError" ||
        error.name === "AbortError") {
      return reply("GPT отвечает слишком долго. Повтори вопрос.");
    }

    return reply("Ошибка соединения с OpenAI.");
  }
}
