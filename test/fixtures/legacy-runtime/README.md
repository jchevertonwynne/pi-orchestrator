# Legacy runtime fixtures

These directories contain unchanged copies of the older runtime modules needed by the registry compatibility tests.
The tests copy the modules into temporary directories and use synthetic registries.
This keeps the tests independent of the repository's commit history.

Keep the copies unchanged when editing `src/`.
They test what different versions of the runtime can read and write, not what a simulated version check would do.
