export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['']/g, "")
    .split(/\W+/)
    .filter((w) => w.length > 3);
}

/**
 * Weighted fuzzy score: 50% title→tag, 30% question→tag, 20% text→front.
 * Tags carry more medical signal than raw card text.
 */
export function fuzzyScore(
  questionText: string,
  cardFront: string,
  cardTags: string[] = [],
  title = ""
): number {
  const qSet = new Set(tokenize(questionText));
  const titleSet = new Set(tokenize(title));
  if (!qSet.size && !titleSet.size) return 0;

  // CamelCase-split tag words: "HeartFailure" → ["heart", "failure"]
  const tagWords = new Set(
    cardTags.flatMap((tag) =>
      tag
        .split("::")
        .slice(1)
        .flatMap((segment) =>
          tokenize(segment.replace(/([a-z])([A-Z])/g, "$1 $2"))
        )
    )
  );

  // Title → tag overlap (most precise signal)
  let titleTagOverlap = 0;
  for (const t of titleSet) if (tagWords.has(t)) titleTagOverlap++;
  const titleTagScore = titleSet.size > 0 ? titleTagOverlap / titleSet.size : 0;

  // Question text → tag overlap
  let qTagOverlap = 0;
  for (const t of qSet) if (tagWords.has(t)) qTagOverlap++;
  const qTagScore = qSet.size > 0 ? qTagOverlap / qSet.size : 0;

  // Question text → card front overlap
  const cSet = new Set(tokenize(cardFront));
  let textOverlap = 0;
  for (const t of qSet) if (cSet.has(t)) textOverlap++;
  const textScore =
    qSet.size > 0
      ? textOverlap / Math.sqrt(qSet.size * Math.max(cSet.size, 1))
      : 0;

  return titleTagScore * 0.5 + qTagScore * 0.3 + textScore * 0.2;
}
