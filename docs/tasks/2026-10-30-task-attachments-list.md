---
status: done
---

# Lista degli allegati del task

## Specs

- [Conversation](../specs/conversation.md) (Attachments)
- [Clients](../specs/clients.md) (Task view, Native app)

La pagina del manuale [Tasks and conversations](../manual/tasks-and-conversations.md) descrive la nuova sezione.

## Problem Statement

Gli allegati di un Task oggi si vedono solo uno alla volta: dentro i Commenti nella conversazione e, per i file della descrizione, come link nel testo. Chi apre un Task non ha un posto dove vedere in un colpo solo tutto ciò che è stato caricato, da chi e quando, né sul web né nell'app nativa.

## Solution

Una sezione **Attachments** sotto la descrizione, in entrambi i client, con tutti i file del Task dal più recente: quelli caricati dall'editor della descrizione e quelli allegati a qualsiasi Commento, sia di un utente sia di un agente. Ogni riga è compatta: anteprima per le immagini, nome, dimensione, autore (o "Description") e tempo; le immagini si aprono in una nuova tab, gli altri file si scaricano. La sezione compare solo quando il Task ha almeno un allegato.

Il backend espone `GET /tasks/:taskId/attachments`, che restituisce ogni allegato del Task con `createdAt` e l'autore del Commento (`null` per i file della descrizione), escludendo i file di un Commento eliminato.

## User Stories

1. Come utente, voglio vedere tutti gli allegati di un Task sotto la descrizione, così non devo cercarli nella conversazione.
2. Come utente, voglio vedere chi ha caricato ogni file — una persona o un agente — e quando, così capisco da dove arriva.
3. Come utente, voglio un'anteprima per le immagini e il download per gli altri file, così riconosco subito cosa c'è.
4. Come utente dell'app nativa, voglio la stessa lista nella schermata di dettaglio, così l'esperienza è coerente.
5. Come utente, voglio che un file appena caricato compaia subito, senza ricaricare la pagina.

## Implementation Decisions

### Backend

- `loadTaskAttachments` legge gli allegati del Task (`attachments.task_id`) uniti a quelli dei suoi Commenti, ordinati per data di caricamento decrescente, e risolve gli autori in un'unica query per tipo di attore.
- La rotta `GET /tasks/:taskId/attachments` accetta id o chiave del Task come le altre, risponde `404` se il Task non esiste.
- Il tipo condiviso è `TaskAttachment`: `Attachment` più `createdAt` e `author: Actor | null`.

### Web app

- `useTaskAttachments` alimenta `TaskAttachments`, montato sotto `Description` in `TaskDetail`.
- Il pannello è una lista con divisori: miniatura `img` per PNG/JPEG/GIF/WebP/AVIF, icona documento per gli altri; nome, dimensione, autore (icona bot per gli agenti) e `Time`; icona di anteprima o download.
- Le invalidazioni arrivano dagli eventi in tempo reale: `comment.created/updated/deleted` e `timeline.reset` invalidano la lista; un upload dalla descrizione la invalida subito, prima del salvataggio; `task.removed` la rimuove dalla cache.

### App nativa

- Il controller carica `/tasks/:id/attachments` insieme al resto del Task e la conserva nella cache del profilo, così la lista si legge anche offline.
- Ogni evento che provoca il refresh del Task riallinea la lista.
- La sezione usa `SectionLabel` + `AppTile`: icona per tipo, nome, sottotitolo `dimensione · autore · tempo`, tap che scarica nel profilo e apre il file col viewer di sistema.

## Testing Decisions

- **Backend** (`backend/test/comments.test.ts`): un file della descrizione e uno di un Commento elencati dal più recente, con autore e metadati; un Commento eliminato toglie i suoi file; `404` per un Task inesistente.
- **Web (Playwright)** (`frontend/e2e/attachments.spec.ts`): descrizione e Commento con allegato, lista visibile con entrambi, autore e "Description", link dell'immagine inline e del documento con `?download=1`.
- **App nativa** (`mobile-app/test/task_attachments_test.dart`): il controller carica e mette in cache la lista; i dettagli mostrano "Attachments (2)", i nomi, l'autore e la provenienza.

## Acceptance Criteria

- [x] Sotto la descrizione appare la lista di tutti gli allegati del Task, dal più recente.
- [x] Sono inclusi i file della descrizione e quelli di ogni Commento, di utenti e agenti.
- [x] Ogni riga mostra nome, dimensione, autore (o "Description") e tempo.
- [x] Le immagini hanno un'anteprima; il clic apre l'immagine o scarica gli altri file.
- [x] La lista si aggiorna quando arrivano o spariscono allegati, senza ricaricare.
- [x] La stessa lista è nell'app nativa, anche offline, e i file si scaricano al tap.
- [x] Senza allegati la sezione non occupa spazio.
