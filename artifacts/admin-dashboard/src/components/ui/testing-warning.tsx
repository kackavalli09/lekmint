import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function TestingWarning() {
  return (
    <Alert className="mb-6 border-amber-400/60 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:border-amber-700/60 dark:text-amber-200 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription>
        <strong className="font-semibold">Active testing.</strong>{" "}
        Some of the novel functionalities of this mint are under active testing. Do not deposit balances you cannot afford to lose.
      </AlertDescription>
    </Alert>
  );
}
