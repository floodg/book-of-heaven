-- 2026-04-25: persist per-thread chat model selection
--   * adds nullable chat_threads.model to remember model choice by thread
--   * NULL remains supported for legacy rows and default fallback behavior

alter table chat_threads
  add column model text null;
