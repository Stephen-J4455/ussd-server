import app from "../src/app.js";

export default function handler(req, res) {
  req.url = "/ussd";
  return app(req, res);
}
