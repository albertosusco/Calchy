# Calchy: note per Claude

## Prima di pubblicare una nuova versione

- **Chiave fissa per l'APK Android.** Finché nei Secrets del repository mancano
  `ANDROID_KEYSTORE` (keystore in base64) e `ANDROID_KEYSTORE_PASSWORD`, ogni APK è
  firmato con una chiave temporanea diversa e su Android non si aggiorna sopra la
  versione precedente. Prima di aumentare la versione, ricorda all'utente di creare
  la chiave fissa (comandi nel README, sezione per sviluppatori) e chiedi se l'ha
  già salvata. Se nel log del job "APK per Android" compare l'avviso
  "Chiave ANDROID_KEYSTORE non trovata", la chiave manca ancora.
- Nei titoli delle PR non scrivere `@nome` fuori dagli apici inversi: le note della
  release vengono generate dai titoli e GitHub lo legge come una menzione.
- La release parte da sola quando su `main` arriva un nuovo `version` in
  `src-tauri/tauri.conf.json` (aggiornare anche `package.json`, `package-lock.json`,
  `src-tauri/Cargo.toml` e `src-tauri/Cargo.lock`).
