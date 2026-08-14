import * as vscode from 'vscode';
import { SidecarClient, ExtractedDataSourceInfo } from '../sidecar/SidecarClient';

/**
 * Extracts data source details from a screenshot using VS Code's own language
 * model API.
 *
 * The sidecar talks to the Copilot REST endpoint directly, and some endpoints -
 * internal proxies in particular - reject image input outright even though they
 * advertise vision-capable models. Going through `vscode.lm` instead reuses the
 * same Copilot session the editor already uses for chat, where image input is
 * supported.
 *
 * The prompt and the parsing of the model's reply both stay on the server, so
 * each has a single definition.
 */

/** Result of an extraction attempt, including why it could not run. */
export interface VisionExtractionOutcome {
    /** Populated when the model returned a parseable answer. */
    result?: ExtractedDataSourceInfo;
    /** Set when extraction could not be attempted or failed. */
    unavailableReason?: string;
}

/**
 * Picks a Copilot chat model, preferring ones known to handle images well.
 */
async function selectVisionModel(): Promise<vscode.LanguageModelChat | undefined> {
    // Families are tried in order; the first that resolves is used.
    const preferredFamilies = ['gpt-4o', 'gpt-4.1', 'claude-sonnet-4.6', 'gemini-3.1-pro-preview'];

    for (const family of preferredFamilies) {
        try {
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
            if (models.length > 0) {
                return models[0];
            }
        } catch {
            // Selector unsupported or model unavailable - try the next family.
        }
    }

    try {
        const anyCopilot = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        return anyCopilot[0];
    } catch {
        return undefined;
    }
}

/**
 * Runs screenshot extraction through the editor's language model.
 */
export async function extractDataSourceViaLanguageModel(
    client: SidecarClient,
    imageBase64: string,
    imageMimeType: string,
    mode: string,
    log: (message: string) => void,
    token: vscode.CancellationToken
): Promise<VisionExtractionOutcome> {
    if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
        return { unavailableReason: 'This version of VS Code does not expose the language model API.' };
    }

    const model = await selectVisionModel();
    if (!model) {
        return { unavailableReason: 'No Copilot chat model is available. Sign in to GitHub Copilot and try again.' };
    }

    log(`[Vision] Using VS Code language model: ${model.vendor}/${model.family} (${model.name})`);

    let systemPrompt: string;
    try {
        systemPrompt = await client.getExtractionPrompt(mode);
    } catch (error) {
        return { unavailableReason: `Could not load the extraction prompt: ${describe(error)}` };
    }

    const imageBytes = Buffer.from(imageBase64, 'base64');

    // The language model API has no system role, so the instructions are sent as
    // the leading user message alongside the image.
    const messages = [
        vscode.LanguageModelChatMessage.User([
            new vscode.LanguageModelTextPart(
                `${systemPrompt}\n\nExtract the cluster/database information from this screenshot.`
            ),
            vscode.LanguageModelDataPart.image(new Uint8Array(imageBytes), imageMimeType)
        ])
    ];

    let reply = '';
    try {
        const response = await model.sendRequest(messages, {}, token);
        for await (const chunk of response.text) {
            reply += chunk;
        }
    } catch (error) {
        if (error instanceof vscode.LanguageModelError) {
            return { unavailableReason: `The language model rejected the request: ${error.message}` };
        }
        return { unavailableReason: describe(error) };
    }

    if (!reply.trim()) {
        return { unavailableReason: 'The language model returned an empty response.' };
    }

    log(`[Vision] Model replied with ${reply.length} characters`);

    try {
        const parsed = await client.parseExtraction(reply, mode);
        return { result: parsed };
    } catch (error) {
        return { unavailableReason: `Could not parse the model's reply: ${describe(error)}` };
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
