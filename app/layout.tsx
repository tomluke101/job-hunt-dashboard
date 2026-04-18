import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import Sidebar from "./_components/Sidebar";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "HuntHQ — Job Hunt Dashboard",
  description: "Your personal job hunting command centre",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en" className={`h-full ${inter.variable}`}>
        <body className="h-full flex font-sans antialiased">
          <Sidebar />
          <main className="flex-1 overflow-y-auto min-h-screen bg-slate-50">
            {children}
          </main>
        </body>
      </html>
    </ClerkProvider>
  );
}
