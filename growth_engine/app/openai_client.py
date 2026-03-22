"""
Async OpenAI client — singleton, shared across the process lifetime.

Model selection (consistent with existing GSC architecture):
  GPT-4o-mini — planner, angle generator, hook generator, writer, critic, rewriter
  (Upgrade to GPT-4o for quality-critical operations if needed in future phases)

The client is constructed once at first use (lazy singleton via lru_cache).
All callers receive the same instance — no per-request construction overhead.
"""

from __future__ import annotations

from functools import lru_cache

from openai import AsyncOpenAI

from app.config import settings
from app.logging_config import get_logger

log = get_logger(__name__)

# Default models — match existing GSC architecture
PLANNER_MODEL = "gpt-4o-mini"
WRITER_MODEL = "gpt-4o-mini"
CRITIC_MODEL = "gpt-4o-mini"   # Models are excellent at critique tasks
HOOK_MODEL = "gpt-4o-mini"


@lru_cache(maxsize=1)
def get_openai_client() -> AsyncOpenAI:
    """
    Return the shared async OpenAI client.
    Raises RuntimeError if OPENAI_API_KEY is not set.
    """
    if not settings.openai_api_key:
        raise RuntimeError(
            "OPENAI_API_KEY is required for content generation. "
            "Set it in your environment variables."
        )
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    log.info("openai_client_initialized")
    return client


async def chat_completion(
    messages: list[dict],
    model: str = WRITER_MODEL,
    temperature: float = 0.7,
    max_tokens: int = 1500,
    response_format: dict | None = None,
) -> str:
    """
    Run a chat completion and return the response content string.

    Args:
        messages:       OpenAI messages array (system + user turns)
        model:          Model ID string
        temperature:    0.0 = deterministic, 1.0 = creative
        max_tokens:     Max response tokens
        response_format: {"type": "json_object"} for structured JSON output

    Returns:
        Raw string content from the first choice message.
    """
    client = get_openai_client()
    kwargs = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if response_format:
        kwargs["response_format"] = response_format

    response = await client.chat.completions.create(**kwargs)
    content = response.choices[0].message.content or ""
    log.debug(
        "openai_completion",
        model=model,
        input_tokens=response.usage.prompt_tokens if response.usage else None,
        output_tokens=response.usage.completion_tokens if response.usage else None,
    )
    return content
