export function HealthScore({ collateral, required, reserve }: { collateral: bigint; required: bigint; reserve: bigint }) {
  const coverageRatio = required === 0n ? 100 : Number((collateral * 100n) / required);
  const reserveRatio = collateral === 0n ? 0 : Number((reserve * 100n) / collateral);

  const coverageScore = Math.min(100, coverageRatio);
  const reserveScore = Math.min(100, Math.max(0, reserveRatio));

  const healthScore = Math.round((coverageScore * 0.7 + reserveScore * 0.3));

  let grade: "excellent" | "good" | "fair" | "poor";
  let gradeColor: string;

  if (healthScore >= 80) {
    grade = "excellent";
    gradeColor = "text-success bg-success/10";
  } else if (healthScore >= 60) {
    grade = "good";
    gradeColor = "text-accent bg-accent/10";
  } else if (healthScore >= 40) {
    grade = "fair";
    gradeColor = "text-yellow-500 bg-yellow-500/10";
  } else {
    grade = "poor";
    gradeColor = "text-danger bg-danger/10";
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted">Account Health Score</p>
      <div className="mt-3 flex items-center justify-between">
        <div>
          <p className="text-4xl font-bold">{healthScore}</p>
          <p className={`mt-1 text-sm font-semibold px-2 py-1 rounded w-fit ${gradeColor}`}>
            {grade.charAt(0).toUpperCase() + grade.slice(1)}
          </p>
        </div>
        <div className="text-right text-xs text-muted">
          <p>Coverage: {coverageRatio.toFixed(0)}%</p>
          <p>Reserve: {reserveRatio.toFixed(0)}%</p>
        </div>
      </div>
      <div className="mt-3 h-2 bg-border rounded overflow-hidden">
        <div
          className={`h-full transition-all ${
            healthScore >= 80 ? "bg-success" :
            healthScore >= 60 ? "bg-accent" :
            healthScore >= 40 ? "bg-yellow-500" :
            "bg-danger"
          }`}
          style={{ width: `${healthScore}%` }}
        />
      </div>
    </div>
  );
}
