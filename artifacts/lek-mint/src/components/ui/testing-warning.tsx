import { AlertTriangle } from "lucide-react";

export function TestingWarning() {
  return (
    <div className="w-full bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex gap-3 text-amber-800 dark:text-amber-300 mb-6">
      <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
      <p className="text-sm leading-relaxed">
        <strong className="font-semibold">Active testing.</strong>{" "}
        Some of the novel functionalities of this mint are under active testing. Do not deposit balances you cannot afford to lose.
      </p>
    </div>
  );
}
