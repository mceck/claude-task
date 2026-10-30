---
status: done
---

# Correzioni di affidabilità e concorrenza della piattaforma

## Specs

- [Users and auth](../specs/users-and-auth.md)
- [Board](../specs/board.md)
- [Conversation](../specs/conversation.md)
- [Wikis](../specs/wikis.md)
- [Agent sessions](../specs/agent-sessions.md)
- [Agents](../specs/agents.md)
- [Runner](../specs/runner.md)
- [Git integration](../specs/git-integration.md)
- [Clients](../specs/clients.md)
- [Voice Rooms](../specs/voice-rooms.md)

## Problem Statement

Operazioni concorrenti, risposte HTTP tardive e disconnessioni potevano lasciare dati incoerenti nelle viste web e native, perdere Comment destinati agli Agent, saltare la preparazione delle Worktree o lasciare container accesi durante lo shutdown. Alcune validazioni accettavano dati inutilizzabili, e il recovery dell'Admin revocava le Login HTTP senza chiudere i WebSocket già autenticati.

## Solution

Correggere i difetti confermati nelle aree della piattaforma, verificando i comportamenti attraverso API pubbliche, browser, app nativa e Runner reale. Il recupero delle Login si propaga dal CLI al server dopo il commit. Le liste iniziali si caricano completamente anche mentre arrivano eventi, le cancellazioni aggiornano le viste aperte, e lifecycle, Queue e Worktree restano coerenti durante chiusure e retry.

## User Stories

1. Come Admin, voglio che il recovery della password termini anche le connessioni realtime delle Login precedenti, così che l'accesso revocato finisca su ogni trasporto.
2. Come Admin, voglio che bootstrap e CLI accettino credenziali utilizzabili nel login, così da poter sempre accedere dopo la creazione.
3. Come User, voglio vedere tutti i Task della Board anche quando arrivano eventi durante il primo caricamento.
4. Come User, voglio che una risposta HTTP tardiva conservi gli aggiornamenti già ricevuti.
5. Come User, voglio che un Task cancellato sparisca anche dalla pagina diretta e dalle viste già aperte.
6. Come User, voglio vedere la rimozione dei Task quando un Admin cancella un Project.
7. Come User, voglio che gli edit vuoti di Status e Tag restituiscano la risorsa corrente e che le cancellazioni concorrenti mantengano coerenti Revision e versioni.
8. Come User, voglio conservare gli spazi significativi del Markdown quando modifico un Comment.
9. Come User, voglio che i risultati dei Survey raggiungano l'Agent anche dopo una riassegnazione.
10. Come User di una Wiki, voglio titoli, ordine e unread aggiornati e una nuova Chat assegnata all'Agent corrente.
11. Come User, voglio che un Comment inviato durante chiusura, riapertura o disconnessione resti in Queue finché può essere consegnato.
12. Come User, voglio che chiusura del Task e recupero di un Comment non inviato si serializzino senza deadlock.
13. Come User, voglio che il banner Unseen Changes rappresenti modifiche effettive e che una conversazione mancante riparta coerentemente.
14. Come Admin, voglio Build, log e ricreazioni affidabili anche con eliminazione dell'Agent o arresto del backend.
15. Come Admin, voglio che lo shutdown fermi anche i container la cui creazione o ripartenza era già in corso.
16. Come Admin, voglio usare Dockerfile validi con commenti nelle continuazioni e installare i servizi dopo l'intero FROM.
17. Come User, voglio che un retry dopo una preparazione Git cancellata esegua setup e configurazione upstream.
18. Come Agent, voglio Task Tools con validazioni e ambiti coerenti e nuovi Task non assegnati quando li creo con il tool.
19. Come User, voglio che rinomina dei repository e letture fallite dopo un merge riuscito siano gestite correttamente.
20. Come User, voglio che errori temporanei di rete o snapshot Voice falliti permettano il recupero della connessione.
21. Come User dell'app nativa, voglio che cambio Login, selezione Chat, refresh e retry di assegnazione mantengano dati e destinazione corretti.
22. Come Admin, voglio migrazioni concorrenti serializzate e letture blob coerenti quando manca il file dati.

## Implementation Decisions

- Conservare API, modello di scheduling e invarianti di Session e Job; l'avanzamento dello Status al merge resta una funzionalità separata.
- Usare transazioni e l'ordine Project, Task, Agent, Session prima di modificare Delivery e Queue. Il recupero di input non inviato verifica anche il Job a cui appartiene la Delivery.
- Sostituire password e revocare Login nello stesso commit della transazione. Pubblicare le revoche con PostgreSQL, identificando solo le Login terminate.
- Ascoltare le revoche su una connessione dedicata del backend. In caso di perdita del listener, chiudere i WebSocket e riprendere le nuove connessioni dopo la riconnessione e la nuova autenticazione.
- Per le liste web, applicare eventi parziali solo a dati già caricati. Completare il primo snapshot e riconciliare gli eventi arrivati durante il caricamento, senza bloccare il caricamento iniziale con cancellazioni ripetute.
- Resettare le query dei Task cancellati, così da aggiornare gli observer montati e risolvere le viste attive con una nuova GET.
- Fermare i container durante il drain dello shutdown e ricontrollare quelli ancora accesi al termine del drain del scheduler, in parallelo alla chiusura HTTP. Attendere infine anche i messaggi pubblicati dagli handler di chiusura dei Runner.
- Rimuovere le Worktree incomplete anche quando la cancellazione arriva durante il checkout hook, così che il retry rifaccia setup e upstream.
- Trattare commenti e righe vuote nelle continuazioni Dockerfile allo stesso modo in validazione e riscrittura.
- Mantenere le modifiche mobile compatibili con storage per User e Installation, versioni dei Task e destinazione esplicita dei retry.

## Testing Decisions

- Backend: API HTTP, WebSocket e MCP con PostgreSQL reale e runtime, Runner e provider Git simulati. Il recovery CLI usa un processo separato.
- Concorrenza: controllare le operazioni Docker attraverso il runtime simulato e coordinare il conflitto Queue/chiusura alla scrittura nel database, verificando le risposte HTTP reali.
- Runner: binario Go con backend WebSocket simulato, eseguibile Claude simulato e repository Git locali; verificare anche il retry sulla stessa Worktree dopo cancellazione.
- Frontend: Playwright su server reale, trattenendo gli snapshot iniziali di Board, Build e Job e verificando sia pagina Task sia dialog della Board.
- Utility condivise: verificare che un Dockerfile accettato resti valido dopo il pin della Base Image e l'inserimento dei servizi.
- Harness: attendere ricezione ed elaborazione di hello tramite una barriera ping/pong prima di osservare lo stato del fake Runner.
- Verifiche finali: typecheck completo, suite backend e browser, suite Go con race detector; suite Flutter completa già verificata sul codice mobile invariato dalla review correttiva.

## Acceptance Criteria

- [x] Recovery CLI atomico e revoca dei WebSocket precedenti, con recupero sicuro del listener.
- [x] Board, Build e Job conservano una lista completa quando gli eventi arrivano sul primo caricamento.
- [x] Task cancellati rimossi da pagina diretta e dialog della Board.
- [x] Recupero di Comment non inviati serializzato con la chiusura del Task.
- [x] Retry Worktree con Setup Script eseguito e upstream configurato dopo cancellazione.
- [x] Dockerfile con commenti e righe vuote nelle continuazioni riscritto correttamente.
- [x] Shutdown con stop anticipato e container creati durante il drain fermati.
- [x] Difetti confermati nelle altre aree corretti e documentati nel resoconto sotto.
- [x] Typecheck, suite backend, browser e Go con race detector completati sul codice finale.
- [x] Task chiuso e commit bugfix consolidati, conservando il commit della funzionalità merge/Status.

## Verification

| Verifica | Risultato |
| --- | --- |
| Typecheck monorepo | Passato |
| Build frontend e backend | Passata |
| Suite backend con PostgreSQL | 494 passati, 9 skip opt-in |
| Suite Playwright | 70 passati, 3 skip TURN opt-in |
| Runner Go, vet e suite con race detector | Passati |
| Flutter, verificato nella review prima dei fix correttivi che lasciano il mobile invariato | 203 passati |
| GolangCI sul diff correttivo | Nessun nuovo rilievo; il controllo completo mantiene 50 rilievi errcheck preesistenti |
| Review Standards e Task delle correzioni | Nessun rilievo residuo |

## Out of Scope

L'avanzamento dello Status dopo merge è mantenuto nel proprio commit. Limiti aggregati dei topic WebSocket, riduzione del payload massimo condiviso con il Runner e backfill degli hint last4 storici restano hardening separato. I test di integrazione che richiedono provider esterni o TURN reale mantengono il proprio opt-in.

## Further Notes

Questo task sostituisce il resoconto di bug hunt alla radice del repository. I singoli difetti confermati, i test associati e le verifiche delle aree sono conservati qui sotto.

## Fixes verified

### Auth & Logins

- **Il recovery CLI con una nuova password non terminava le Login esistenti.** Un cookie rubato restava valido dopo il reset dell'Admin.
  - Test: `backend/test/users.test.ts` → "ending every Login when the CLI replaces a password".
  - Fix: il CLI aggiorna password e Login in una transazione; la revoca delle Login chiude anche i WebSocket già aperti attraverso notifiche PostgreSQL dopo il commit.
- **Il primo login con un'email sconosciuta calcolava un hash Argon2 in più.** Il dummy hash era lazy, quindi la prima probe impiegava circa il doppio di una password sbagliata.
  - Fix: hash dummy Argon2id costante, verificato a ogni probe senza hash a runtime.

Nessun altro bug confermato: login, logout, cambio password, scadenza/revoca, CSRF e rate limiting corrispondono alla spec.

### Users, Avatars & Registration

- **Il CLI `create-admin` accettava email invalide e password oltre il limite del login.** Un Admin creato con `--password` di 201 caratteri o con un'email non valida non poteva poi autenticarsi.
  - Test: `backend/test/users.test.ts` → "refuses credentials the app could never accept".
  - Fix: stessa validazione di email e lunghezza password del login; email e display name vengono trimmati nel service.

### Notifications & read positions

Nessun bug confermato: mention, follow/mute, read position monotona, unread counts, device ownership, retry e filtri di consegna corrispondono alla spec.

### Realtime & Voice Rooms

- **Uno snapshot Voice fallito disabilitava Join per sempre.** Il pulsante era `disabled` anche su `room.isError`, ma il join è un comando WebSocket e non richiede lo snapshot.
  - Test: `frontend/e2e/voice.spec.ts` → "a failed room snapshot leaves Join voice available".
  - Fix: Join resta attivo; lo snapshot serve solo alla presenza.
- **Lo stato Voice sopravviveva al logout**, mostrando al Login successivo un errore "Voice connection lost".
  - Fix: `voice.reset()` al logout azzera stanza, partecipazione, microphone ed errori.
- Restano come hardening (non bug funzionali) il limite aggregato di topic per connessione e il `maxPayload` da 64 MB condiviso con il Runner: non toccati in questo ciclo.

### Shared domain utilities & validation

- **Le liste CSV dei filtri non accettavano spazi dopo la virgola.** `assignee=id1, id2` produceva un id con spazio iniziale e `400`.
  - Test: `backend/test/tasks.test.ts` → "filters by assignee, including unassigned".
  - Fix: split, trim e flatten sia delle stringhe sia degli array di query.
- **I commenti dentro una continuazione Dockerfile non venivano ignorati.** `FROM base \` + commento + `AS x` veniva rifiutato, anche se Docker elimina i commenti prima di unire le righe.
  - Test: `backend/test/shared.test.ts` → "ignores comments inside Dockerfile continuations".
  - Fix: blank e comment lines vengono saltate anche con una continuazione aperta, sia nella validazione sia nella riscrittura del FROM prima dell'installazione dei servizi.
- **`chatCommands` accettava nomi ereditati da `Object.prototype`.** `toString`/`constructor` venivano offerti come comandi Claude.
  - Test: shared.test.ts → "does not offer inherited object names as Claude commands".
  - Fix: `Object.hasOwn`.
- **Le skill con nome che inizia con `_` o `-` non venivano mai offerte.** `commandName` richiedeva un primo carattere alfanumerico.
  - Test: shared.test.ts → "offers skill names that start with an underscore or dash".
  - Fix: il primo carattere può essere `_` o `-`.
- **Gli spazi a fine riga dentro un valore multilinea tra doppi apici venivano persi.** Il parser trimava la riga prima di leggere il contenuto quotato.
  - Test: shared.test.ts → "preserves spaces at the end of a line inside a multiline quoted value".
  - Fix: il valore viene riletto dalla riga non trimmata dopo il primo `=`.

### Projects & Project logos

- **La cancellazione permanente di un Project non pubblicava rimozioni.** Chi aveva aperto la Board o un Task vedeva ancora card e vista del Task cancellato; solo un reload lo scopriva.
  - Test: `backend/test/projects.test.ts` → "announces Task removals when a Project is deleted".
  - Fix: la transazione emette `task.deleted` sul topic del Project e `task.removed` su ogni Task prima del commit.

### Tasks: CRUD, ordering, revisions & filters

- **Una chiave con zeri iniziali apriva il Task sbagliato.** `GET /tasks/API-01` risolveva `API-1` perché `Number()` normalizzava le cifre.
  - Test: `backend/test/tasks.test.ts` → "gets a task by id or by Task Key".
  - Fix: il numero deve essere la forma canonica (`String(Number(digits)) === digits`), altrimenti `404`.
- **Tag deletion poteva desincronizzare tags, versione e Revision.** La scansione dei Task e il DELETE dei `task_tags` non erano serializzati con gli edit dei Task; due delete concorrenti potevano bumpare la versione con una Revision vuota.
  - Test: `tasks.test.ts` → "serializes concurrent deletions of the same Tag without a no-op revision".
  - Fix: la delete del Tag prende il lock esclusivo del Project (gli edit dei Task prendono quello condiviso) e rilegge il Tag dopo il lock, così il secondo delete è `404`.

### Statuses & Tags

- **PATCH con body vuoto rispondeva 500.** `PATCH /statuses/:id` e `PATCH /tags/:id` accettano un oggetto vuoto (tutti i campi sono opzionali), ma passavano `{}` a Drizzle `update().set()`, che lancia `No values to set` e finiva nell'handler generico come `500 internal`.
  - Test: `backend/test/projects.test.ts` → "treats an empty edit as a no-op instead of a server error".
  - Fix: un'edit senza campi restituisce la risorsa invariata (`200`) senza emettere eventi, sia per gli Status sia per i Tag.

### Comments, attachments & mentions

- **L'edit di un commento perdeva gli spazi significativi del Markdown.** `updateCommentBody` faceva `.trim()` sul body, quindi un code block indentato perdeva l'indentazione e un commento identico veniva considerato modificato (con `editedAt` valorizzato).
  - Test: `backend/test/comments.test.ts` → "keeps whitespace-significant Markdown and treats the same body as unchanged".
  - Fix: il body viene conservato com'è; solo un body composto da soli spazi viene rifiutato con `400`.

### Questions & Surveys

- **I risultati di un Survey chiuso mentre l'Agent era unassigned andavano persi per sempre.** Il System Comment con i risultati diventava `not_delivered`; al rientro dello stesso Agent `reassign` escludeva tutti i System Comments e la conversazione iniziale di un nuovo Agent escludeva i notice.
  - Test: `backend/test/conversation-tools.test.ts` → "delivers Survey results to the same Agent when it is assigned again".
  - Fix: i System Comment con `noticeMessage` (risultati Survey e Notify agent) entrano sia nel reinvio allo stesso Agent sia nel primo messaggio di una nuova Session.

### Wikis & Wiki Chats

- **Modificare il primo commento di una Chat non aggiornava il titolo live.** Il titolo è derivato dal primo User Comment, ma `updateComment` non emetteva `wiki.changed`.
  - Test: `backend/test/wikis.test.ts` → "announces a Chat title change when its first Comment is edited".
  - Fix: ogni edit di commento su una Wiki emette `wiki.changed` oltre a `comment.updated`.
- **New Chat restituiva una Chat vuota ancora assegnata al vecchio Agent.** Dopo un cambio Agent, la Chat vuota riusata conservava `agentId` vecchio: i client la mostravano come "run by altro Agent" e bloccavano il composer.
  - Test: `wikis.test.ts` → "hands out an empty Chat on the Wiki current Agent after a switch".
  - Fix: `reserveChat` riassegna una Chat vuota all'Agent corrente della Wiki.
- **Eliminare l'Agent corrente di una Wiki lasciava la Wiki senza Agent.** Il controllo delle Session aperte non copriva il `defaultAgentId` della Wiki; il FK lo azzerava.
  - Test: `wikis.test.ts` → "refuses deleting the Agent that runs a Wiki".
  - Fix: l'eliminazione risponde `409` finché l'Agent è quello della Wiki.
- **Le Chat muted perdevano l'indicatore unread.** `listChats` faceva `unread && !muted`, ma il mute deve solo silenziare le notifiche.
  - Test: `wikis.test.ts` → "keeps the unread indicator for a muted Wiki".
  - Fix: la Chat list usa `unread` senza guardare `muted`.
- **Le risposte Agent non emettevano `wiki.changed`.** I commenti proiettati dallo stream o creati via Task Tool aggiornavano il task ma non la Chat list (ordine e unread restavano stale).
  - Test: `wikis.test.ts` → "announces Agent Comments on the Wikis topic".
  - Fix: il flush del scheduler pubblica `wiki.changed` per ogni Task aggiornato di una Wiki.
- **Il titolo di una Chat ignorava il primo Internal Note e i commenti senza testo.** Il titolo usava il primo commento non-internal non vuoto, quindi cambiava quando arrivava un commento successivo.
  - Test: `wikis.test.ts` → "titles a Chat from its first User Comment even when it is an Internal Note".
  - Fix: il titolo usa il primo User Comment non cancellato; un body vuoto resta "Chat".

### Agent Sessions

- **Il recupero di input non inviato poteva causare deadlock con la chiusura del Task.** Bloccava Comment e Agent prima del Task; l'inserimento in Queue aspettava poi la foreign key del Task bloccato dalla chiusura.
  - Test: `backend/test/sessions.test.ts` → "serializes an unsent mid-Turn Comment with closing its Task".
  - Fix: lock Project/Task prima di Agent/Session/Comment e verifica del Job originario della Delivery.
- **Un Comment poteva essere scritto in un Job già in chiusura e marcato `delivered` senza arrivare all'Agent.** Dopo un close+reopen o un pause+resume la Session tornava `idle` mentre il Job era ancora `running` con `cancelRequested`; `deliverComment` controllava solo lo stato del Job.
  - Test: `backend/test/sessions.test.ts` → "queues a Comment posted after reopening while the cancelled Job is still exiting".
  - Fix: l'iniezione richiede Session `running`, Job `running`, nessun `cancelRequested`/`discardOutput`, Runner pronto e nessuna Queue Entry.
- **Il recovery di un Job senza output stream lo trattava come Turn interrotto.** `lastSeq > 0` contava anche `job.accepted`; i Comment restavano `delivered` e non venivano rimessi in coda.
  - Test: `sessions.test.ts` → "requeues the Comments when a restarted Job never started streaming".
  - Fix: il branch `resume_interrupted` richiede una projection persistita (vero output), altrimenti i Comment tornano in Queue.
- **Un Comment queued cancellato restava "Queued" per sempre se l'entry conteneva altri Comment.** `dropIfEmpty` non toccava il commento cancellato.
  - Test: `sessions.test.ts` → "marks a deleted Comment not delivered while its Entry keeps the other Comments".
  - Fix: la cancellazione stacca il Comment dalla entry e lo segna `not_delivered` con reason `comment deleted`.
- **Un titolo modificato e poi ripristinato lasciava il banner Unseen Changes acceso per sempre.** La SQL guardava solo l'esistenza di revisioni, mentre Notify confrontava il valore netto e rispondeva `409`.
  - Test: `sessions.test.ts` → "does not claim unseen changes for a value that ended where it started".
  - Fix: `unseenChangesSql` confronta before/after netti per campo, come la lista inviata da Notify.
- **Una Session con conversazione sparita restava `idle` con `started=false`.** Il chip diceva "waiting for messages" e il container veniva tenuto acceso.
  - Test: `sessions.test.ts` → "marks a Session whose conversation disappeared as pending, not idle".
  - Fix: lo stato diventa `pending` (tranne Session closed/paused).

### Agents & Extensions (builds, skills, catalog)

- **L'harness e2e presupponeva Agent `idle` subito dopo la creazione**, ma con `AGENT_STOP_WHEN_UNUSED=true` (default) il container non viene creato finché non c'è lavoro e lo stato resta `offline`. Non è un bug del prodotto: il server e2e ora parte con `AGENT_STOP_WHEN_UNUSED=false`.
  - Test: intera suite Playwright; prima 11 fallimenti, poi verde.


- **Un recreate fallito lasciava il DB convinto che il container fosse aggiornato.** `recreate` salvava il nuovo token e `containerSpec=desired` prima di creare il container: se Docker falliva o il backend moriva, il vecchio container restava con il vecchio token e nessun reconcile lo sostituiva.
  - Fix: `containerSpec` resta `null` finché il container non esiste; un retry o un restart lo ricrea. Se l'Agent viene cancellato durante la creazione, il container nuovo viene rimosso.
- **La cancellazione di un Agent durante una Build poteva far crashare il scheduler e lasciare l'immagine appena creata.** La riga Build spariva per cascade e `serializeBuild(finished!)` dereferenziava `undefined`; `removeAgent` aveva già fatto pruning prima che la Build taggasse la nuova immagine.
  - Fix: la finalizzazione è in transazione, il caso riga sparita è gestito e l'immagine viene rimossa se l'Agent non esiste più.
- **Force recreate veniva rimandato quando l'Agent non aveva lavoro.** Il branch "unused" vinceva su `forceRecreate`.
  - Test: `backend/test/agent-idle-stop.test.ts` → "applies Force recreate immediately even with no work".
  - Fix: il branch unused non si applica a una force recreate.
- **Un Comment arrivato durante lo stop idle poteva aspettare il tick di 30 secondi.** Dopo che Docker finiva lo stop non c'era un nuovo kick.
  - Fix: dopo lo stop, se c'è lavoro, il container viene svegliato subito.
- **Il log di Build smetteva di aggiornarsi al cap di 256 KB.** Il flush confrontava la lunghezza, che resta costante quando si tiene solo la coda.
  - Fix: un contatore di versione per ogni scrittura e flush serializzati, attesi prima della scrittura finale.
- **Una Build interrotta tra l'insert e `imageState='building'` non veniva ripresa.** `resetInterruptedBuilds` guardava solo gli Agent già `building`.
  - Test: `backend/test/agents.test.ts` → "restarts a Build interrupted before the Agent reached building state".
  - Fix: resetta `imageState` degli Agent derivandoli dalle Build `building`, e insert/finalizzazione di Build e stato immagine sono atomici.

### Timeline projection

- **`api_retry` con `attempt == max_retries`:** verificato contro il test e il contratto esistente, che trattano quel valore come retry esauriti. Nessuna modifica; non è un bug confermato.
- **Un comando Bash riuscito con "exit code N" nell'output veniva riportato come errore.** Il regex sull'output vinceva sul flag `isError`.
  - Test: `backend/test/projection.test.ts` → "a successful Bash call is exit 0 even when its output mentions another exit code".
  - Fix: per Bash si usa `isError`; l'exit code si legge solo dai risultati falliti.
- **Testo assistant composto da soli spazi sopprimeva il fallback del result.** `hasVisibleOutput` era impostato prima del controllo `trim`.
  - Test: `projection.test.ts` → "whitespace-only text does not hide the successful result text".
  - Fix: solo testo non vuoto dopo trim conta come output visibile.

### Runner protocol (backend hub, handlers, uploads)

- **`hello` non ripeteva i comandi pendenti dopo una disconnessione.** Un Job `finishing` non riceveva di nuovo `job.end`; un Job cancellato mentre il Runner era offline non riceveva `job.cancel`; una Session paused non riceveva interrupt/end.
  - Test: `sessions.test.ts` → "replays job.end when a finishing Job reconnects" e "replays job.cancel when the Task was closed while the Runner was away".
  - Fix: `hello` deriva l'intento da `cancelRequested`, `discardOutput`, stato della Session e stato `finishing`.
- **Un Job poteva essere dispatchato prima del `hello`.** `isConnected` era vero appena il socket era aperto; un dispatch nella finestra veniva poi recuperato e perso.
  - Test: `sessions.test.ts` → "waits for the Runner hello before dispatching a Job".
  - Fix: `RunnerHub` espone `isReady` (socket + hello) e dispatch/iniezione lo usano.
- **`recoverAbandonedJobs` poteva interrompere un Job appena riconnesso.** Il check `isConnected` avveniva prima della transazione e non veniva ripetuto sotto lock.
  - Test: `sessions.test.ts` → "does not recover a Job whose Runner reconnected while recovery waited".
  - Fix: ricontrolla `runnerDisconnectedAt` e la connessione dopo aver bloccato l'Agent.
- **Un Job cancellato poteva ancora postare System Comment per conversazione mancante/già esistente.** I branch `missing`/`exists` non guardavano `cancelRequested`.
  - Test: `sessions.test.ts` → "stays quiet when a cancelled Job reports a missing conversation".
  - Fix: i notice di recovery non vengono emessi per Job cancellati.

### MCP server & Task Tools

- **`create_task` applicava il default Agent del Project.** Il contratto dice "new, unassigned", ma `createTask` assegnava sempre il default.
  - Test: `backend/test/mcp.test.ts` → "does not apply the Project default Agent to a Task created by the tool".
  - Fix: `createTask` accetta `assignDefaultAgent: false`; il tool lo usa.
- **Titoli composti da soli spazi passavano la validazione MCP.** Lo schema Zod non faceva trim, mentre la REST API sì.
  - Test: `mcp.test.ts` → "rejects blank titles in both write tools".
  - Fix: `update_task` e `create_task` usano `z.string().trim().min(1)`.
- **`open_pull_request` ricontrollava solo lo stato del Job.** Un Job cancellato o una Session paused non venivano esclusi al secondo gate.
  - Fix difensivo: il gate richiede `cancelRequested = false` e Session `running`.

### Git integration

- **Un repository GitHub rinominato/spostato rompeva ogni chiamata.** Le API usavano owner/name e `redirect: 'error'`, quindi il 301 diventava un errore.
  - Test: `backend/test/github-provider.test.ts` → "follows a renamed repository through GitHub redirects".
  - Fix: segue i redirect same-origin (la risposta cross-origin viene rifiutata).
- **La Push Policy accettava pkt-line malformati o un body senza comandi e li inoltrava al provider.** Un fallback con `newId` vuoto passava il controllo.
  - Test: `backend/test/git-proxy.test.ts` (malformed packet + unreachable upstream).
  - Fix: ogni comando deve avere old/new object id validi e almeno un comando.
- **`open_pull_request` poteva usare una Base Branch vecchia** letta prima di acquisire il lock condiviso del Project.
  - Fix: rilegge il Project dopo il lock e usa repository/baseBranch correnti.
- **Un merge GitHub riuscito veniva riportato come fallimento se la GET successiva falliva.** Il PUT era già andato a buon fine.
  - Test: `github-provider.test.ts` → "reports a successful merge when the follow-up read fails".
  - Fix: il provider restituisce il PR merged dal PUT; il service registra revision, comment e avanzamento Status.

### Config, secrets, blobstore & server lifecycle

- **Due processi che migravano insieme fallivano con `23505`.** Il migrator Drizzle crea schema e tabella ledger con `IF NOT EXISTS` fuori dalla propria transazione.
  - Test: `backend/test/migrations.test.ts` → "serializes two processes migrating the same empty database".
  - Fix: `runMigrations` tiene un advisory lock session-level su una connessione dedicata.
- **L'Admin bootstrap poteva essere creato con credenziali che il login rifiutava.** Email >320 o password >200 (o <8) creavano un Admin inutilizzabile.
  - Test: `backend/test/config.test.ts`.
  - Fix: `loadConfig` valida email e lunghezza password con le stesse regole del login.
- **`FsBlobStore.get` restituiva uno stream per un file dati mancante** (sidecar rimasto dopo un delete interrotto), causando 500/200 troncati.
  - Test: `backend/test/blobstore.test.ts` → "returns null when the data file is missing but its metadata sidecar remains".
  - Fix: verifica che il file dati esista prima di restituire lo stream.
- **Lo shutdown poteva non fermare nessun container entro il grace period di Compose.** `close()` aspettava `scheduler.settle()` (che include Build lunghe) prima di chiamare `stopContainer`; con `stop_grace_period: 30s` il processo veniva ucciso prima.
  - Test: `backend/test/shutdown.test.ts` → "stops containers within the grace period instead of waiting for the Build".
  - Fix: lo stop dei container parte in parallelo al drain; dopo il drain un secondo controllo ferma i container avviati nel frattempo. Gli errori vengono riportati dopo il cleanup.
- **Una creazione Docker già avviata poteva lasciare acceso un container durante lo shutdown.** Lo stop anticipato precedeva la fine della creazione e il controllo finale poteva aspettare il keepalive HTTP di una richiesta di recreate.
  - Test: `backend/test/shutdown.test.ts` → "stops a container whose creation completes after the early shutdown stop", sia da rebuild sia da recreate pubblico.
  - Fix: drain del scheduler e controllo finale dei container in parallelo alla chiusura HTTP; secondo drain dei messaggi dei Runner prima di chiudere il database.
- Nota: gli hint `last4` scritti prima della regola "vuoto sotto 12 caratteri" restano nei record esistenti; non c'è modo di ricavare la lunghezza originale senza decifrare. Non è stato aggiunto un backfill distruttivo.

### Frontend data layer & state

- **La cancellazione della query Queue sugli eventi ha causato una regressione e2e.** Dopo il remove di un Queue Entry la lista diventava vuota: il fix "cancella la query in volo prima di scrivere l'evento" è stato rimosso. Gli eventi `queue.changed` sostituiscono la lista come prima; resta un rischio teorico di una GET tardiva, non riprodotto dopo il revert.


- **Un Task cancellato mentre la vista era aperta restava editabile.** `task.deleted`/`task.removed` invalidavano soltanto, e React Query conserva i dati su 404.
  - Test: `frontend/e2e/concurrency.spec.ts` → "deleting a Task closes its Board dialog view instead of leaving a stale editor" e variante standalone.
  - Fix: gli eventi resettano le query del Task, notificando anche le viste già montate e ricaricando quelle attive, e rimuovono timeline/session/voice dalla cache. La pagina diretta e la modale mostrano il messaggio di cancellazione.
- **Una GET Board tardiva sovrascriveva card già aggiornate via WebSocket.** Il version guard era solo nel path eventi.
  - Test: `concurrency.spec.ts` → "a late Board snapshot does not roll back a newer card event".
  - Fix: `structuralSharing` fonde per versione. Gli eventi cancellano snapshot precedenti di liste già complete; sul primo caricamento lasciano terminare lo snapshot e poi riconciliano la lista intera, mantenendo il refresh necessario anche se arrivano altri eventi.
- **Un 401 da una write non faceva ricontrollare il Login.** Nessuna mutation Query, quindi l'`onError` cache non scattava.
  - Test: `frontend/e2e/security.spec.ts` → "a 401 from a write rechecks the Login and sends you to login".
  - Fix: il client API chiama un handler globale che invalida `me` su ogni 401 (tranne `/auth/me`).
- **`useMe` non ritentava errori transitori**, lasciando l'app su "Can't reach the server" dopo un singolo 502.
  - Test: `security.spec.ts` → "a transient failure loading the current User is retried".
  - Fix: rimossa la `retry: false`; vale la regola globale (niente retry solo sui 4xx).
- **Build/job cache potevano essere rollbackati da snapshot HTTP in volo.**
  - Fix: le liste già complete annullano gli snapshot precedenti; gli eventi arrivati sul primo caricamento avviano una riconciliazione completa dopo lo snapshot. La Queue riceve già liste complete e mantiene il proprio aggiornamento diretto.
- **Voice Room: uno snapshot fallito disabilitava Join per sempre.**
  - Test: `frontend/e2e/voice.spec.ts` → "a failed room snapshot leaves Join voice available".
  - Fix: Join resta attivo; lo snapshot serve solo alla presenza.

### Mobile app (Flutter)

- **Un singolo timeout HTTP lasciava l'app "Offline" per sempre** anche con WebSocket sano; solo il socket poteva tornare `connected`.
  - Test: `mobile-app/test/controller_test.dart` → "a successful request restores the connection after an HTTP-only failure".
  - Fix: la riuscita HTTP ripristina `connected` se il live socket è su.
- **Un Login scaduto e un altro User sullo stesso dispositivo mantenevano Task/Timeline del precedente.** `_expire`/`_activate` non azzeravano la selezione.
  - Test: controller_test → "signing in as another User clears the previous Task and conversation".
  - Fix: `_resetProfileState()` su activate/expire (mantiene solo il pending notification).
- **"Retry assignment" applicava l'Agent al Task aperto, non a quello fallito.**
  - Test: controller_test → "retrying an Agent assignment targets the Task that failed".
  - Fix: retry memorizza `(taskId, agentId)` e fa PATCH diretto sul Task giusto; banner scoped.
- **Una `selectChat` fallita lasciava header e Task disallineati** e il composer inviava alla Chat precedente.
  - Test: `mobile-app/test/wiki_test.dart` → "a failed Chat selection keeps the previous Chat selected".
  - Fix: ripristina `openChat` precedente in caso di errore.
- **Una notifica toccata offline non veniva più aperta al reconnect.**
  - Test: controller_test → "a notification tapped offline opens its Task after reconnecting".
  - Fix: dopo il refresh al reconnect viene consumato `pendingTaskId`.
- **Una refresh lenta poteva riportare il Task a una versione vecchia**, causando 409 falsi al salvataggio successivo.
  - Test: controller_test → "a stale refresh cannot roll back a newer Task".
  - Fix: `_fetchTask` ignora risposte con versione inferiore; anche la cache offline non sovrascrive una card più nuova.

### Runner (Go binary)

- **Un hook git che lasciava un processo in background bloccava la preparazione della Worktree.** `cmd.Wait` aspettava la chiusura delle pipe.
  - Test: `runner/test/stability_test.go` → `TestGitHookBackgroundProcessDoesNotHangWorktreePreparation`.
  - Fix: `WaitDelay` + process group kill; `ErrWaitDelay` non è un errore del comando.
- **Una Worktree creata ma con preparazione fallita veniva riusata come inizializzata**, saltando upstream e setup.
  - Test: esteso `TestSetupRunsAfterAFailedPreparationOfANewGitWorktree` (upstream dopo retry).
  - Fix: su errore o cancellazione durante la creazione la directory viene rimossa e il retry la ricrea, eseguendo setup e configurazione upstream.
- **Un Setup Script cancellato che intercettava TERM e usciva 0 risultava riuscito**, cancellando il marker `setup-pending`.
  - Test: esteso `TestCancelStopsTheSetupScript`.
  - Fix: `runStep` controlla `isCancelled()` anche con exit 0.
- **mise non rilevava i file `conf.d`**, quindi `mise install` non partiva.
  - Test: esteso `TestMiseInstallBeforeProjectSetup` con `.config/mise/conf.d/tools.toml`.
  - Fix: scansione delle directory `conf.d`.
