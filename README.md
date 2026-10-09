# Together Neu

Ein neu aufgebauter Together-Prototyp mit:
- echten Accounts (E-Mail + Passwort-Hash)
- Sitzungswiederherstellung inklusive Token
- einmaligen Couple-Codes (24 Stunden)
- WebSocket-Echtzeitereignissen
- privatem Paar-Chat mit gespeicherten letzten 200 Nachrichten

## Cloudflare-Deployment
1. Entpacke die ZIP.
2. Lade den Ordner `Together_Neu` in ein GitHub-Repository hoch oder öffne ihn in einer lokalen Wrangler-Umgebung.
3. Cloudflare Workers muss Durable Objects mit SQLite unterstützen.
4. Deploye mit `npx wrangler deploy`.
5. Öffne die von Cloudflare ausgegebene URL.

Die ZIP enthält einen neuen Worker und ein neues Frontend. Sie kann nicht automatisch deine bestehende Cloudflare-Instanz aktualisieren; Deployment und Funktionstest auf deiner Cloudflare-URL sind danach erforderlich.
