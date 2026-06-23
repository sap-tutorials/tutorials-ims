require("@sap/cds").connect.to("db")
  .then(() => { console.log("OK"); process.exit(0); })
  .catch(e => { console.error("ERR:", e.message); process.exit(1); });
