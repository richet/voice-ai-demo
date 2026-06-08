import "dotenv-flow/config";
import express from "express";
import ExpressWs from "express-ws";
import OpenAI from "openai";
import { OpenAIRealtimeWebSocket } from "openai/realtime/websocket";
import bot from "./bot";
import log from "./logger";
import type { CallStatus } from "./twilio";
import { TwilioMediaStreamWebsocket } from "./twilio";

const { app } = ExpressWs(express());
app.use(express.urlencoded({ extended: true })).use(express.json());

// ========================================
// Twilio Voice Webhook Endpoints
// ========================================
app.post("/incoming-call", async (req, res) => {
  log.twl.info(`incoming-call from ${req.body.From} to ${req.body.To}`);

  try {
    // The OpenAI Realtime session is created in the incoming-call webhook to avoid an
    // extra delay after the call is connected. The client_secret returned here is tied
    // to the session and is passed to the websocket relay via route parameter.
    const oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const { value: ephemeralKey } = await oai.realtime.clientSecrets.create({
      session: { type: "realtime", model: bot.model },
    });

    res.status(200);
    res.type("text/xml");

    const host = process.env.HOSTNAME!.replace(/^https?:\/\//, "");
    const streamUrl = `wss://${host}/media-stream/${ephemeralKey}`;
    log.twl.info(`stream url: ${streamUrl}`);

    // The <Stream/> TwiML noun tells Twilio to send the call to the websocket endpoint below.
    res.end(`\
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>
`);
  } catch (error) {
    log.oai.error(
      "incoming call webhook failed, probably because OpenAI websocket could not connect.",
      error,
    );
    res.status(500).send();
  }
});

app.post("/call-status", async (req, res) => {
  const status = req.body.CallStatus as CallStatus;

  if (status === "error") log.twl.error(`call-status ${status}`);
  else log.twl.info(`call-status ${status}`);

  res.status(200).send();
});

// ========================================
// Twilio Media Stream Websocket Endpoint
// ========================================
app.ws("/media-stream/:client_secret", async (ws, req) => {
  log.twl.info("websocket initializing");

  const tw = new TwilioMediaStreamWebsocket(ws);
  const rt = new OpenAIRealtimeWebSocket(
    { model: bot.model },
    new OpenAI({ apiKey: req.params.client_secret! }), // client_secret links the session configuration
  );

  rt.on("error", (err) => log.oai.error("realtime error", err));

  // both websockets must be connected before any media can be relayed
  await Promise.all([
    new Promise((resolve) => rt.on("session.created", () => resolve(null))),
    new Promise((resolve) =>
      tw.on("start", (msg) => {
        tw.streamSid = msg.start.streamSid; // streamSid is needed to send actions
        resolve(null);
      }),
    ),
  ]);

  log.twl.info("websocket connected");

  rt.send({
    type: "session.update",
    session: {
      type: "realtime",
      ...bot.session,
      audio: {
        ...bot.session.audio,
        input: { ...bot.session.audio?.input, format: { type: "audio/pcmu" } },
        output: { ...bot.session.audio?.output, format: { type: "audio/pcmu" } },
      },
    },
  });

  // prompts the agent to say something
  rt.send({
    type: "response.create",
    response: {
      instructions: `You just answered the call. Greet the caller by saying exactly: "Hello, this is ABC Plumbing, how can I help you today?"`,
    },
  });

  // ========================================
  // Audio Orchestration
  // ========================================
  // send bot's speech to twilio
  rt.on("response.output_audio.delta", (msg) =>
    tw.send({
      event: "media",
      media: { payload: msg.delta },
      streamSid: tw.streamSid!,
    }),
  );

  // send human speech to openai
  tw.on("media", (msg) =>
    rt.send({ type: "input_audio_buffer.append", audio: msg.media.payload }),
  );

  // clear buffer when the user starts speaking
  rt.on("input_audio_buffer.speech_started", () => {
    log.app.info("user started speaking");

    rt.send({ type: "input_audio_buffer.clear" });
    tw.send({ event: "clear", streamSid: tw.streamSid! });
  });

  // clean up websocket
  ws.on("close", () => {
    rt.close();
  });
});

/****************************************************
 Start Server
****************************************************/
const port = process.env.PORT || "3000";
app.listen(port, () => {
  log.app.info(`server running on http://localhost:${port}`);
});
