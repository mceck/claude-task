---
status: done
---

# Ritardo della notifica di connessione nell'app nativa

## Specs

- [Clients](../specs/clients.md)

## Problem Statement

Ogni volta che si apre o si riapre l'app nativa la connessione live parte da zero, e la notifica "Reconnecting…" (o "Offline · …") compariva già al primo frame, sparendo appena il socket tornava su. Su un avvio normale la riconnessione richiede poche centinaia di millisecondi, quindi la notifica lampeggiava senza segnalare un problema reale.

## Solution

Mostrare la notifica solo se la disconnessione dura più di due secondi. Il ritardo vive nel widget della notifica, così il suo timer si annulla con lo smontaggio della UI e non sopravvive alla chiusura dell'app. Il ritorno in primo piano azzera la notifica e riavvia il ritardo insieme alla riconnessione.

## User Stories

1. Come User dell'app nativa, voglio che riaprire l'app non mostri per un attimo la notifica di connessione quando la rete è disponibile.
2. Come User dell'app nativa, voglio comunque vedere "Offline · …" o "Reconnecting…" quando la connessione manca davvero, con il pulsante Reconnect.

## Implementation Decisions

- Il ritardo è di due secondi, definito da `connectionNoticeDelay` in `mobile-app/lib/src/app.dart`.
- `_ConnectionNotice` tiene nascosta la notifica, arma un timer quando la connessione manca e lo annulla quando torna; l'epoch passato da `_TaskAppState` riavvia il ritardo al rientro in primo piano.
- Lo stato di connessione del controller non cambia: le azioni che richiedono rete restano disabilitate subito, e la notifica continua a distinguere "Reconnecting…" (tentativo in corso) da "Offline · …" (socket perso).

## Testing Decisions

- Test widget: una riconnessione entro il ritardo non mostra nulla; una disconnessione che dura oltre il ritardo mostra la notifica e la nasconde al ritorno della connessione; il rientro in primo piano la nasconde e riavvia il ritardo.

## Acceptance Criteria

- [x] Riaprire l'app con rete disponibile non mostra la notifica di connessione.
- [x] Una disconnessione reale mostra la notifica solo dopo due secondi.
- [x] Ritorno in primo piano e riconnessione nascondono la notifica senza lampeggi.
