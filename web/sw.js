self.addEventListener("push", async (event) => {
  // Payload encryption yok (MVP), o yüzden server'da son kampanyayı KV’de tutuyoruz.
  // Push gelince Worker’dan lastCampaign çekip bildirimi onunla göstereceğiz.
  try {
    const workerBase = self.location.origin; // Pages domain değilse aşağıda override edeceğiz
    // Bu MVP’de sw.js Pages domaininde çalışacak, workerBase'i index.html'den set edeceğiz.
  } catch (e) {}

  let title = "Bildirim";
  let body = "";

  try {
    // index.html SW'e worker URL'yi gönderiyor
    const workerBase = (await self.registration.scope) || "";
    const res = await fetch(self.__WORKER_BASE__ + "/lastCampaign");
    const data = await res.json();
    title = data.title || title;
    body = data.body || body;
  } catch (e) {
    // fallback
    body = "Yeni bildirim var.";
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon.png",
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SET_WORKER_BASE") {
    self.__WORKER_BASE__ = event.data.workerBase;
  }
});
