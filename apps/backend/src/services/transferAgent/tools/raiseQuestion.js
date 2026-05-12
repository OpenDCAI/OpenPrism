import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';

/**
 * Creates the raiseQuestion tool — pauses the graph and asks the user a question.
 * The frontend will display the question(s) and resume with answers via POST /submit-confirm.
 *
 * When this tool is called, it triggers a LangGraph interrupt. The graph will
 * be suspended until the user provides answers via the API.
 *
 * @param {{ getState: () => object }} ctx — accessor for current graph state
 */
export function createRaiseQuestionTool(ctx) {
  return new DynamicStructuredTool({
    name: 'raiseQuestion',
    description:
      'Ask the user one or more questions and pause execution until they respond. ' +
      'Use this ONLY when you genuinely need user input to proceed ' +
      '(e.g. ambiguous migration choices, blind-review decisions). ' +
      'Do NOT use this for information you can determine from the files.',
    schema: z.object({
      questions: z
        .array(
          z.object({
            id: z.string().describe('Unique question identifier, e.g. "float_strategy"'),
            prompt: z.string().describe('The question text to show the user'),
            options: z
              .array(z.string())
              .describe('Available answer choices'),
          }),
        )
        .min(1)
        .max(5)
        .describe('Array of questions to ask'),
    }),
    func: async ({ questions }) => {
      // Format questions for the pendingQA state field
      const pendingQA = questions.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        type: 'single',
        options: q.options,
      }));

      // Trigger LangGraph interrupt — this suspends the graph
      // The interrupt value is picked up by the graph runner
      interrupt({
        type: 'raiseQuestion',
        pendingQA,
      });

      // This return value is used if/when the graph resumes
      // The actual answers will be in state.userConfirmations
      return '[PAUSED] Questions sent to user. Awaiting response. When resumed, check state.userConfirmations for answers.';
    },
  });
}
