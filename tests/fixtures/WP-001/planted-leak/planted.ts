// Synthetic fixture for SEC-054 (WP-001 test set). Stands in for a file under
// apps/ that has accidentally been committed with a leaked private term. The
// term below is invented (see ../leak-terms.synthetic.txt) — never a real
// customer name — because the test-author role must never place a real
// customer term anywhere in a public-reachable test fixture (C5, C10).
export const noteThatShouldNeverShip = "zzyzxglarnok";
