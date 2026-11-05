# Doing Now

## v0.0.9 - Collaboration Enhancements

- [ ] #54 **REST writes to a file someone has open are overwritten by the next live-editing save.** Every text write
      becomes a CRDT edit of the file's stored Yjs state and is published to the live room.
- [ ] #55 **Renaming or deleting a file that has a live room can recreate it.** Rooms track their stored document; a
      rename moves it, a delete makes the room close (code 4404) without writing, and the editor follows.
- [ ] #56 **A hard server crash can lose up to ~800 ms of typing; a crashed replica's cursors linger.** A per-replica
      Redis update log replayed on load and by a beat task; awareness entries expire after 30 s.

