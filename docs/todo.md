# Doing Now

## v0.0.9 - Collaboration Enhancements

- [ ] #56 **A hard server crash can lose up to ~800 ms of typing; a crashed replica's cursors linger.** A per-replica
      Redis update log replayed on load and by a beat task; awareness entries expire after 30 s.

