export default async function handler(req, res) {
  const API = "https://script.google.com/macros/s/AKfycby0QbuUt1JStLpMyMEOqOX9ib3KbESE5SM0tBGEghFTIxkisY0_r_UujCuMQ9yZbyu3/exec";
  const r = await fetch(API, {
    method: req.method,
    headers: { "Content-Type": "application/json" },
    body: req.method === "POST" ? JSON.stringify(req.body) : undefined,
  });
  const txt = await r.text();
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  res.status(r.status).send(txt);
}
