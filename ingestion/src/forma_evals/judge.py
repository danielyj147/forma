"""DeepEval judge backed by the Anthropic API (Haiku by default — the judge
runs many times per metric; Opus is overkill and violates the cost policy).
Supports DeepEval's schema-enforced prompts via Anthropic structured outputs."""

from __future__ import annotations

import json

from anthropic import Anthropic
from deepeval.models import DeepEvalBaseLLM


class AnthropicJudge(DeepEvalBaseLLM):
    def __init__(self, model: str = "claude-haiku-4-5"):
        self.model_name = model
        self.client = Anthropic()

    def load_model(self):
        return self.client

    def generate(self, prompt: str, schema=None):
        if schema is not None:
            response = self.client.messages.create(
                model=self.model_name,
                max_tokens=4000,
                messages=[{"role": "user", "content": prompt}],
                output_config={
                    "format": {"type": "json_schema", "schema": schema.model_json_schema()}
                },
            )
            return schema.model_validate(json.loads(response.content[0].text))
        response = self.client.messages.create(
            model=self.model_name,
            max_tokens=4000,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text

    async def a_generate(self, prompt: str, schema=None):
        return self.generate(prompt, schema)

    def get_model_name(self) -> str:
        return f"anthropic/{self.model_name}"
