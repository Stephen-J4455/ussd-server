import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { handleUssdRequest } from "./menu.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(cors());
app.use(morgan("tiny"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function normalizePayload(body) {
  return {
    sessionId: body.sessionId || body.session_id || "",
    serviceCode: body.serviceCode || body.service_code || "",
    phoneNumber: body.phoneNumber || body.msisdn || body.phone || "",
    text: body.text || ""
  };
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "mystiwan-ussd-server" });
});

app.post("/ussd", async (req, res) => {
  const payload = normalizePayload(req.body || {});

  try {
    const ussdResponse = await handleUssdRequest(payload);
    res.status(200).type("text/plain").send(ussdResponse);
  } catch (error) {
    console.error("USSD processing error:", error);
    res.status(200).type("text/plain").send("END Service temporarily unavailable.");
  }
});

app.post("/ussd/callback", (req, res) => {
  // Optional hook for providers that send asynchronous delivery/payment events.
  console.log("USSD callback payload:", req.body);
  res.status(200).json({ ok: true });
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

export default app;
