# BarkOggle – Multiplayer Server

Echtes 1-gegen-1 über das Internet. Der Server verbindet zwei Spieler im selben
Modus und gleicht die Bell-Punkte in Echtzeit ab. Ist niemand online, spielt das
Spiel automatisch gegen einen Bot weiter (Fallback).

## Ordnerstruktur
```
barkoggle-server/
  package.json
  server.js
  public/
    index.html   <- das Spiel
```

## 1) Lokal testen (auf deinem PC)
Im Ordner `barkoggle-server` eine Eingabeaufforderung öffnen und:
```
npm install
npm start
```
Dann im Browser öffnen: http://localhost:3000

Zum echten Testen: ein zweites Fenster (oder Handy im selben WLAN) auf dieselbe
Adresse. Beide denselben Modus wählen und „Match suchen" drücken -> ihr trefft
aufeinander.

Tipp Handy im WLAN: statt localhost die lokale IP deines PCs nehmen, z. B.
http://192.168.0.42:3000 (IP findest du mit `ipconfig`).

## 2) Online stellen mit Render (kostenlos)
1. Lade diesen Ordner als eigenes Repository zu GitHub hoch
   (Name z. B. `barkoggle-server`).
2. Auf https://render.com einloggen -> **New** -> **Web Service**.
3. Dein GitHub-Repo auswählen.
4. Einstellungen:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. **Create Web Service**. Nach 1-2 Minuten bekommst du eine URL wie
   `https://barkoggle-server.onrender.com` – das ist dein Spiel, teilbar mit Freunden.

Hinweis Render Free: der Server „schläft" nach ~15 Min ohne Besucher ein; der
erste Aufruf danach dauert ein paar Sekunden zum Aufwachen. Für mehr brauchst du
einen bezahlten Plan oder einen kleinen VPS.

## Was noch fehlt (nächste Schritte)
- **Live-Kamera zwischen echten Spielern (WebRTC):** aktuell siehst du im echten
  Match die eigene Kamera; das Bild des Gegners wird noch nicht übertragen. Das
  ist ein eigener Baustein (WebRTC Peer-to-Peer + dieser Server als „Signaling").
- Optional: ELO serverseitig speichern (DB), damit es nicht nur lokal im Browser liegt.

---

## Neu in dieser Version

### Gegen Freunde (Code-Räume)
Im Menü „Gegen Freunde (Code)" -> **Raum erstellen** zeigt einen 5-stelligen Code.
Dein Freund tippt ihn unter **Raum beitreten** ein -> ihr spielt 1v1.
**Nur in Freundes-Räumen ist die Kamera erlaubt** (Zufalls-Matches laufen mit
Avatar/Stimme – bewusst, aus Sicherheits- und Jugendschutzgründen).

### Report-System + Admin-Ansicht
Meldungen (Spitzname, Grund, Modus, Zeit) gehen an den Server – **ohne** Video/Audio.
- Setze in Render unter **Environment** eine Variable `ADMIN_KEY` = dein Geheimwort.
- Reports ansehen im Browser: `https://DEINEAPP.onrender.com/admin/reports?key=DEINKEY`
- Live mitlesen: ein Client kann `adminAuth {key}` senden und bekommt `report`-Events.
- Reports werden zusätzlich in `reports.log` geschrieben (auf Render nicht dauerhaft –
  für dauerhaftes Speichern später eine DB anbinden, z. B. Supabase).

### Shop / VIP (Monetarisierung)
Im Menü das Knochen-Icon. Aktuell **Demo-Käufe** (lokal gespeichert): Werbefrei, VIP
(goldenes Abzeichen + Gold-Fell + 2× XP), Mega-Supporter.
**Echte Zahlungen** brauchen Stripe + einen kleinen Server-Endpoint:
1. Stripe-Account + Produkt/Preise anlegen.
2. Server-Route `/create-checkout-session` (Stripe Checkout) ergänzen.
3. Per **Webhook** den Kauf bestätigen und das Recht serverseitig dem Nutzer gutschreiben
   (dafür brauchst du echte Accounts/Login statt nur localStorage – z. B. Supabase Auth).
Das ist ein eigener Schritt, wenn du so weit bist.

### Rechtliches
Beim Login gibt es jetzt ein Alters-/Einwilligungs-Häkchen + AGB & Datenschutz
(Kurzfassungen, DSGVO-bewusst). **Wichtig:** Als Betreiber in Deutschland musst du noch
ein echtes **Impressum** mit deinen Kontaktdaten ergänzen (kennst du schon von Cliently).
Die Texte sind eine Starter-Fassung, keine Rechtsberatung.

## Noch offen (nächste Schritte)
- **4-Spieler / Party (1v1v1v1)**: eigener Umbau der Spieloberfläche – machen wir separat.
- **Freundes-Kamera live übertragen (WebRTC)**: nur in Code-Räumen, als eigener Schritt.
- **Echte Zahlungen (Stripe)** + echte Accounts (Supabase) für serverseitige Rechte.

## Update: Kamera/Stimme, echtes Bellen, Aufgeben
- **Kamera + Stimme live (WebRTC):** funktioniert in **Freundes-Räumen (Code)**. Zum Testen:
  Fenster 1 -> „Gegen Freunde (Code)" -> *Raum erstellen* (Code merken).
  Fenster 2 -> Code eingeben -> *Raum beitreten*. Im **Kamera-Modus** seht ihr euch +
  hört euch; im **Audio-Modus** hört ihr euch (Avatar). Browser fragt nach Kamera/Mikro-Erlaubnis.
  (Zufalls-Matches bleiben bewusst Avatar/Stimme-frei – Jugendschutz.)
- **Bellen nur per Mikrofon:** Der Button ist weg. Es zählt nur echtes Bellen
  (kurzer, breitbandiger Laut) – lautes Reden/Schreien zählt nicht. Über die
  Mikrofon-Empfindlichkeit in den Einstellungen justierbar. Ohne Mikro-Erlaubnis
  erscheint als Notfall ein Bell-Button.
- **Aufgeben/Verlassen:** Im Spiel oben das Tür-Symbol. Während des Matches = Aufgabe
  (zählt als Niederlage), in der Vorbereitung = einfach zurück ins Menü.
- Leaderboard ist jetzt stabil, Online-Zahl zeigt die echten verbundenen Spieler.

> Hinweis WebRTC: über das Internet braucht es manchmal einen TURN-Server, wenn ein
> Netzwerk strikt ist (NAT). STUN ist eingebaut; falls bei manchen kein Bild kommt,
> später einen TURN-Dienst (z. B. von Twilio/Metered) ergänzen.
