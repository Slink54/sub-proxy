export default async function handler(req, res) {
  const workerUrl = "https://slink54.kondrashin-is05.workers.dev";

  try {
    const response = await fetch(workerUrl, {
      headers: {
        "User-Agent": "Happ/v2ray"
      }
    });

    const userInfo = response.headers.get("subscription-userinfo");
    if (userInfo) {
      res.setHeader("Subscription-Userinfo", userInfo);
    }
    
    res.setHeader("Profile-Update-Interval", "3");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");

    const data = await response.text();
    return res.status(200).send(data);
  } catch (err) {
    return res.status(500).send("Proxy error: " + err.message);
  }
}
