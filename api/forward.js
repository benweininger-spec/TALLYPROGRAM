export default async function handler(req, res) {
  const API = "https://script.google.com/macros/s/AKfycby0QbuUt1JStLpMyMEOqOX9ib3KbESE5SM0tBGEghFTIxkisY0_r_UujCuMQ9yZbyu3/exec";
  const r = await fetch(API, {
    method: req.method,
    headers: { "Content-Type": "application/json" },
    body: req.method === "POST" ? JSON.stringify(req.body) : undefined,
  });
  // === Forge API Config ===
const API = "/api/forward";
async function getJSON(url){ const r = await fetch(url); return r.json(); }
async function postJSON(body){
  const r = await fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  return r.json();
}

// === Load live stock ===
async function loadLiveStock(){
  try{
    const data = await getJSON(`${API}?route=inventory`);
    const inv = data.inventory || [];
    for(const item of ITEMS){
      const row = tbody.querySelector(`.row[data-item="${item.key}"]`);
      const stockInput = row?.querySelector(`[data-field="${item.key}:stock"]`);
      const match = inv.find(x => x.SKU.toLowerCase().includes(item.name.toLowerCase()));
      if(match && stockInput){
        stockInput.value = match.On_Hand || 0;
        saveField(`${item.key}:stock`, match.On_Hand);
      }
    }
  }catch(e){ console.error("Load stock failed", e); }
}

  const txt = await r.text();
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Access-Control-Allow-Headers", "Content-Type");
res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
res.setHeader("Content-Type", "application/json");  // ✅ add this line
if (req.method === "OPTIONS") return res.status(200).end();
res.status(r.status).send(txt);

}
