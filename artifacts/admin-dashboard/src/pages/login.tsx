import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button, Input, Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/core";
import { Lock, ArrowRight, Loader2 } from "lucide-react";
import { getAdminStats } from "@workspace/api-client-react";

export default function Login() {
  const { login } = useAuth();
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;

    setIsLoading(true);
    setError("");

    try {
      // Temporarily store the key to make the fetch request
      sessionStorage.setItem("admin_key", key);
      await getAdminStats();
      login(key); // success, save properly in context
    } catch (err: any) {
      sessionStorage.removeItem("admin_key");
      setError(err?.status === 401 || err?.status === 403 ? "Invalid operator key" : "Connection error");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 relative">
      {/* Blueprint grid background effect */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[linear-gradient(to_right,#808080_1px,transparent_1px),linear-gradient(to_bottom,#808080_1px,transparent_1px)] bg-[size:24px_24px]"></div>
      
      <div className="w-full max-w-sm relative z-10">
        <div className="flex items-center justify-center gap-2 mb-8 text-primary font-bold tracking-widest uppercase text-xl">
          <div className="w-4 h-4 bg-accent rounded-sm" />
          Lek Mint Operator
        </div>

        <Card className="border-border/50 shadow-xl shadow-black/5">
          <CardHeader className="space-y-3 pb-6">
            <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-2 border border-border">
              <Lock className="w-5 h-5 text-foreground" />
            </div>
            <CardTitle className="text-2xl">Authorization Required</CardTitle>
            <CardDescription>
              Enter your administration API key to access the control room.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Input
                  type="password"
                  placeholder="Operator Key..."
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  className="font-mono bg-muted/50 border-border/50 focus-visible:ring-accent focus-visible:border-accent"
                  data-testid="input-operator-key"
                  autoFocus
                />
                {error && <p className="text-sm text-destructive font-medium">{error}</p>}
              </div>
              <Button 
                type="submit" 
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold tracking-wide"
                disabled={isLoading || !key.trim()}
                data-testid="button-unlock"
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                  <>
                    Unlock Console
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
        
        <p className="text-center text-xs text-muted-foreground mt-8 uppercase tracking-widest font-mono">
          Strictly Confidential
        </p>
      </div>
    </div>
  );
}
