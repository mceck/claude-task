---
status: done
---

# Azioni sul container degli Agenti dall'app nativa

## Specs

- [Clients](../specs/clients.md)
- [Agents](../specs/agents.md)

## Problem Statement

L'app nativa permette agli Admin di creare e configurare un Agente, ma non di intervenire sul suo container: per ricostruire l'immagine, riavviare o ricreare il container bisogna aprire il frontend web. Chi segue gli Agenti dal telefono resta bloccato quando un container non risponde o serve una nuova immagine.

## Solution

Il form di modifica di un Agente, già riservato agli Admin, mostra lo stato del container e offre le stesse azioni della pagina Agente del web: Rebuild image, Restart, Recreate when idle e Force recreate. Restart e Force recreate chiedono conferma, perché interrompono il Job in corso. Lo stato del container, la connessione del Runner e l'avviso di una recreation in attesa si aggiornano dagli eventi live dell'Agente. Cronologia delle Build, Usage e log del container restano nel frontend web, insieme alla configurazione Docker.

## User Stories

1. Come Admin, voglio riavviare il container di un Agente dall'app nativa, così non devo aprire il web quando un Job è bloccato.
2. Come Admin, voglio ricostruire l'immagine di un Agente dal telefono, così una modifica al Dockerfile arriva al container senza cambiare client.
3. Come Admin, voglio pianificare una recreation a container fermo oppure forzarla subito, così scelgo se aspettare la fine del Job.
4. Come Admin, voglio vedere lo stato del container e se una recreation è in attesa, così capisco cosa succede prima di agire.
5. Come Admin, voglio una conferma prima di Restart e Force recreate, così non interrompo un Job per un tocco accidentale.

## Implementation Decisions

- Le azioni vivono nel foglio «Edit agent» della schermata Agents, sotto una sezione Container, accanto a Duplicate e Delete; il foglio si apre solo per gli Admin, che sono gli unici autorizzati dal backend.
- Le richieste usano gli stessi endpoint del web: `POST /agents/:id/rebuild`, `POST /agents/:id/restart` e `POST /agents/:id/recreate` (con `{force: true}` per la variante forzata).
- Rebuild image è disabilitato mentre lo stato dell'Agente è `building`, come nel frontend web.
- La riga di stato mostra l'ultimo `containerState` osservato e se il Runner è connesso; l'avviso «Container recreation is waiting for the current Job to finish.» compare con `recreatePending`.
- Il modello `Agent` dell'app nativa legge anche `containerState`, `runnerConnected` e `recreatePending`, così la sezione segue gli eventi `agent.updated` senza riaprire il foglio.
- Le azioni non chiudono il foglio e non salvano le modifiche non inviate del form: agiscono sulla configurazione già attiva dell'Agente, come i pulsanti del web.
- Il testo del Settings hub non cita più le build come esclusivamente web: Dockerfile, cronologia delle Build e Development Services restano lì, ma le azioni sul container sono ora in entrambi i client.

## Testing Decisions

- Test widget della schermata Agents: con un Agente in stato `idle` il foglio mostra `running · Runner connected`; Rebuild image e Recreate when idle inviano rispettivamente `POST /agents/:id/rebuild` e `POST /agents/:id/recreate`; una recreation in attesa mostra l'avviso.
- Test widget delle conferme: Restart apre il dialogo e non invia nulla se annullato; confermando invia `POST /agents/:id/restart`. Force recreate invia `POST /agents/:id/recreate` con `{force: true}` solo dopo la conferma.

## Acceptance Criteria

- [x] Un Admin può ricostruire l'immagine di un Agente dall'app nativa.
- [x] Un Admin può riavviare il container, con conferma che avvisa dell'interruzione del Job.
- [x] Un Admin può pianificare una recreation a container fermo o forzarla subito, con conferma per la variante forzata.
- [x] Il foglio mostra stato del container, connessione del Runner e recreation in attesa, aggiornati dagli eventi live.
- [x] Rebuild image è disabilitato mentre l'Agente sta costruendo l'immagine.
