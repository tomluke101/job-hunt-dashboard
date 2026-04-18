import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="flex flex-col items-center gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white">Job Hunt Dashboard</h1>
          <p className="text-slate-400 text-sm mt-1">Sign in to your account</p>
        </div>
        <SignIn />
      </div>
    </div>
  );
}
