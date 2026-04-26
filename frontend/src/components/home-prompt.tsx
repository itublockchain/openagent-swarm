"use client";

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

export function HomePrompt() {
  const [prompt, setPrompt] = useState("");
  const router = useRouter();

  const handleSubmit = () => {
    if (prompt.trim()) {
      router.push(`/app?task=${encodeURIComponent(prompt)}`);
    } else {
      router.push('/app');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="group relative w-full">
      <div
        className="relative overflow-hidden rounded-xl border shadow-2xl shadow-black/5 dark:shadow-black/20 backdrop-blur-xl transition-all duration-300 sm:rounded-2xl border-border bg-background/80 hover:border-primary/30 dark:border-[#00022F] dark:bg-[rgba(0,2,47,0.6)] dark:hover:border-indigo-900/70"
      >
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe a task for the Swarm..."
          rows={1}
          className="max-h-[150px] min-h-[48px] w-full resize-none bg-transparent px-3 py-3 pr-20 text-sm text-foreground dark:text-neutral-300 placeholder:text-muted-foreground focus:outline-none sm:max-h-[200px] sm:min-h-[56px] sm:px-4 sm:py-4 sm:pr-24 sm:text-base"
          aria-label="Message input"
        />
        <div className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 sm:bottom-3 sm:right-2 sm:gap-1">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!prompt.trim()}
            className={`flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-200 sm:h-9 sm:w-9 ${prompt.trim() ? "bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer" : "cursor-not-allowed bg-accent text-muted-foreground dark:bg-blue-900/30 dark:text-blue-800"}`}
            aria-label="Send message"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-3.5 w-3.5 sm:h-4 sm:w-4"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18"
              />
            </svg>
          </button>
        </div>
      </div>
      <p className="mt-4 hidden text-center text-xs text-muted-foreground dark:text-blue-400/70 sm:block">
        Press{" "}
        <kbd className="rounded bg-accent px-1.5 py-0.5 font-mono text-muted-foreground dark:bg-blue-900/30 dark:text-blue-400">
          Enter
        </kbd>{" "}
        to send,{" "}
        <kbd className="rounded bg-accent px-1.5 py-0.5 font-mono text-muted-foreground dark:bg-blue-900/30 dark:text-blue-400">
          Shift + Enter
        </kbd>{" "}
        for new line
      </p>
    </div>
  );
}
