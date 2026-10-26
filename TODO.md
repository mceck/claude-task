# Spec 04 — Flutter conversation frontend

Checklist operativa aggiornata durante l’implementazione. Specifica: `docs/spec/04-flutter-app.md`.

## Preparazione
- [x] Leggere specifica, convenzioni, contratti API e verificare gli strumenti locali.
- [x] Aggiornare lo stato della specifica e definire i contratti condivisi delle nuove API.

## Backend
- [x] Aggiungere migrazione per preferenze Task, posizioni di lettura, dispositivi e coda notifiche persistente.
- [x] Implementare following automatico per creazione, assegnazione User e partecipazione, rispettando unfollow/mute espliciti.
- [x] Implementare API autenticate per preferenze, lettura monotona e registrazione/rimozione dispositivi.
- [x] Sincronizzare preferenze e lettura solo con le altre connessioni dello stesso User.
- [x] Generare notifiche da Turn e lifecycle persistiti, con selezione destinatari, deduplicazione e retry.
- [x] Integrare trasporto push reale configurabile e stato non configurato, token invalidi e logout.
- [x] Testare API e notifiche su PostgreSQL reale e trasporto push simulato.

## Flutter
- [x] Creare `mobile-app/` con progetti iOS, Android, macOS, Windows e Linux.
- [x] Implementare modelli Dart, client HTTP/WebSocket autenticati e riconnessione con refetch.
- [x] Implementare login, cambio password obbligatorio, scadenza, logout e secure storage.
- [x] Implementare cache isolata per installazione/User, conversazioni offline e bozze persistenti.
- [x] Implementare tema scuro e navigazione adattiva Projects → Tasks raggruppati per Status → conversazione.
- [x] Implementare ricerca, filtri, archivio, creazione Task e Create and start con recupero dell’assegnazione fallita.
- [x] Implementare dettagli/editing Task, Labels, User, Agent e collegamenti Git.
- [x] Implementare Timeline paginata con Markdown, codice, allegati, Revisions, Thinking e Activity.
- [x] Implementare streaming, mantenimento posizione e jump to latest.
- [x] Implementare composer, Internal Notes, file locali, modifica/eliminazione propri Comments e gestione invii ambigui senza retry automatico.
- [x] Implementare Interrupt, Retry e Notify agent con le API esistenti.
- [x] Implementare follow/unfollow/mute e unread condivisi, aggiornando la lettura soltanto a contenuto raggiunto.
- [x] Integrare push telefoniche, permessi, rotazione token e apertura Task dopo autenticazione.
- [x] Testare flussi Flutter: autenticazione, layout, creazione parziale, Timeline, offline, errori invio e notifiche.

## Verifica e consegna
- [x] Eseguire typecheck e test mirati durante lo sviluppo.
- [x] Documentare comandi, URL backend, configurazione push, identificativi, firma e prerequisiti in `mobile-app/README.md`.
- [x] Eseguire Flutter analysis e suite Flutter completa.
- [x] Eseguire typecheck monorepo e suite backend completa finale. (typecheck OK; suite: 1 test fallito in `sessions.test.ts` sulle Task attachments, lavoro separato non di Spec 04.)
- [x] Compilare ed eseguire macOS con gli strumenti disponibili; distinguere gli altri target solo predisposti.
- [ ] Eseguire `/code-review` se disponibile; altrimenti documentare l’assenza ed effettuare una revisione locale equivalente.
- [ ] Registrare esiti e configurazioni esterne ancora necessarie, aggiornando lo stato della specifica con onestà.
- [ ] Proporre `/security-review`, essendo coinvolti autenticazione, storage e push.

## Verifiche esterne
- [ ] Verificare push reale su telefono con credenziali Firebase/APNs e firma dell’installazione (richiede configurazione e dispositivo).
