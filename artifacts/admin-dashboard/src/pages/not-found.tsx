import { Card, CardContent } from "@/components/ui/core";
import { SearchX } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background">
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-2">
            <SearchX className="h-8 w-8 text-destructive" />
            <h1 className="text-2xl font-bold text-foreground">404 Page Not Found</h1>
          </div>

          <p className="mt-4 text-sm text-muted-foreground">
            Did you forget to add the page to the router?
          </p>
          <div className="mt-6 flex justify-end">
            <Link href="/" className="text-sm font-medium text-primary hover:underline">
              Back to Overview
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
