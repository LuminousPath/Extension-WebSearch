import { callPopup, extension_prompt_types, getRequestHeaders, saveSettingsDebounced, setExtensionPrompt, substituteParams } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import { registerDebugFunction } from "../../../power-user.js";
import { SECRET_KEYS, secret_state, writeSecret } from "../../../secrets.js";
import { delay } from "../../../utils.js";

const storage = new localforage.createInstance({ name: "SillyTavern_WebSearch" });
const extensionPromptMarker = '___WebSearch___';

const defaultSettings = {
    triggerPhrases: [
        "tell me",
        "explain me",
        "can you",
        "how to",
        "how is",
        "how do you",
        "ways to",
        "who is",
        "who are",
        "who was",
        "who were",
        "who did",
        "what is",
        "what's",
        "what are",
        "what're",
        "what was",
        "what were",
        "what did",
        "what do",
        "where are",
        "where're",
        "where's",
        "where is",
        "where was",
        "where were",
        "where did",
        "where do",
        "where does",
        "where can",
        "how do i",
        "where do i",
        "how much",
        "definition of",
        "what happened",
        "why does",
        "why do",
        "why did",
        "why is",
        "why are",
        "why were",
        "when does",
        "when do",
        "when did",
        "when is",
        "when was",
        "when were",
        "how does",
        "meaning of",
    ],
    insertionTemplate: '***\nRelevant information from the web ({{query}}):\n{{text}}\n***',
    cacheLifetime: 60 * 60 * 24 * 7, // 1 week
    position: extension_prompt_types.IN_PROMPT,
    depth: 2,
    maxWords: 10,
    budget: 1500,
};

async function onWebSearchPrompt(chat) {
    if (!extension_settings.websearch.enabled) {
        console.debug('WebSearch: extension is disabled');
        return;
    }

    if (!chat || !Array.isArray(chat) || chat.length === 0) {
        console.debug('WebSearch: chat is empty');
        return;
    }

    const startTime = Date.now();

    try {
        console.debug('WebSearch: resetting the extension prompt');
        setExtensionPrompt(extensionPromptMarker, '', extension_settings.websearch.position, extension_settings.websearch.depth);

        if (!secret_state[SECRET_KEYS.SERPAPI]) {
            console.debug('WebSearch: no API key found');
            return;
        }

        // Find the latest user message
        let message = '';

        for (let i of chat.slice().reverse()) {
            if (i.is_system) {
                continue;
            }

            if (i.is_user) {
                message = i.mes;
                break;
            }
        }

        if (!message) {
            console.debug('WebSearch: no user message found');
            return;
        }

        message = processInputText(message);

        if (!message) {
            console.debug('WebSearch: processed message is empty');
            return;
        }

        console.log('WebSearch: processed message', message);

        // Find the first index of the trigger phrase in the message
        const triggerPhrases = extension_settings.websearch.triggerPhrases;

        let triggerPhraseIndex = -1;

        for (let i = 0; i < triggerPhrases.length; i++) {
            const triggerPhrase = triggerPhrases[i];
            const indexOf = message.indexOf(triggerPhrase);

            if (indexOf !== -1) {
                console.debug(`WebSearch: trigger phrase found "${triggerPhrase}" at index ${indexOf}`);
                triggerPhraseIndex = indexOf;
                break;
            }
        }

        if (triggerPhraseIndex === -1) {
            console.debug('WebSearch: no trigger phrase found');
            return;
        }

        // Extract the relevant part of the message (after the trigger phrase)
        message = message.substring(triggerPhraseIndex);

        console.log('WebSearch: extracted query', message);

        // Limit the number of words
        const maxWords = extension_settings.websearch.maxWords;

        message = message.split(' ').slice(0, maxWords).join(' ');

        console.log('WebSearch: query after word limit', message);

        const result = await performSearchRequest(message, { useCache: true });

        if (!result) {
            console.debug('WebSearch: search failed');
            return;
        }

        // Insert the result into the prompt
        let template = extension_settings.websearch.insertionTemplate;

        if (!template) {
            console.debug('WebSearch: no insertion template found, using default');
            template = defaultSettings.insertionTemplate;
        }

        if (!(/{{text}}/i.test(template))) {
            console.debug('WebSearch: insertion template does not contain {{text}} macro, appending');
            template += '\n{{text}}';
        }

        const text = substituteParams(template.replace(/{{text}}/i, result).replace(/{{query}}/i, message));
        setExtensionPrompt(extensionPromptMarker, text, extension_settings.websearch.position, extension_settings.websearch.depth);
        console.log('WebSearch: prompt updated', text);
    } catch (error) {
        console.error('WebSearch: error while processing the request', error);
    } finally {
        console.log('WebSearch: finished in', Date.now() - startTime, 'ms');
    }
}

function processInputText(text) {
    // Convert to lowercase
    text = text.toLowerCase();
    // Remove punctuation
    text = text.replace(/[\\.,@#!?$%&;:{}=_`~\[\]]/g, '');
    // Remove double quotes (including region-specific ones)
    text = text.replace(/["“”]/g, '');
    // Remove carriage returns
    text = text.replace(/\r/g, '');
    // Replace newlines with spaces
    text = text.replace(/[\n]+/g, ' ');
    // Collapse multiple spaces into one
    text = text.replace(/\s+/g, ' ');
    // Trim
    text = text.trim();

    return text;
}

async function performSearchRequest(query, options = { useCache: true }) {
    // Check if the query is cached
    const cacheKey = `query_${query}`;
    const cacheLifetime = extension_settings.websearch.cacheLifetime;
    const cachedResult = await storage.getItem(cacheKey);

    if (options.useCache && cachedResult) {
        console.debug('WebSearch: cached result found', cachedResult);
        // Check if the cache is expired
        if (cachedResult.timestamp + cacheLifetime * 1000 < Date.now()) {
            console.debug('WebSearch: cached result is expired, requerying');
            await storage.removeItem(cacheKey);
        } else {
            console.debug('WebSearch: cached result is valid');
            return cachedResult.text;
        }
    }

    // Perform the search
    const result = await fetch('/api/serpapi/search', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ query }),
    });

    if (!result.ok) {
        const text = await result.text();
        console.debug('WebSearch: search request failed', result.statusText, text);
        return;
    }

    const data = await result.json();
    console.debug('WebSearch: search response', data);

    // Extract the relevant information
    // Order: 1. Answer Box, 2. Knowledge Graph, 3. Organic Results (max 5), 4. Related Questions (max 5)
    let textBits = [];

    if (data.answer_box) {
        switch (data.answer_box.type) {
            case 'organic_result':
                textBits.push(data.answer_box.snippet || data.answer_box.result || data.answer_box.title);

                if (data.answer_box.list) {
                    textBits.push(data.answer_box.list.join('\n'));
                }

                if (data.answer_box.table) {
                    textBits.push(data.answer_box.table.join('\n'));
                }

                break;
            case 'translation_result':
                textBits.push(data.answer_box.translation?.target?.text);
                break;
            case 'calculator_result':
                textBits.push(data.answer_box.result);
                break;
            case 'population_result':
                textBits.push(`${data.answer_box.place} ${data.answer_box.population}`);
                break;
            case 'currency_converter':
                textBits.push(data.answer_box.result);
                break;
            case 'finance_results':
                textBits.push(`${data.answer_box.title} ${data.answer_box.exchange} ${data.answer_box.stock} ${data.answer_box.price} ${data.answer_box.currency}`);
                break;
            case 'weather_result':
                textBits.push(`${data.answer_box.location} ${data.answer_box.weather} ${data.answer_box.temperature} ${data.answer_box.unit}`);
                break;
            case 'flight_duration':
                textBits.push(data.answer_box.duration);
                break;
            case 'dictionary_results':
                textBits.push(data.answer_box.definitions?.join('\n'));
                break;
            case 'time':
                textBits.push(`${data.answer_box.result} ${data.answer_box.date}`);
                break;
            default:
                textBits.push(data.answer_box.result || data.answer_box.answer || data.answer_box.title);
                break;
        }
    }

    if (data.knowledge_graph) {
        textBits.push(data.knowledge_graph.description || data.knowledge_graph.snippet || data.knowledge_graph.merchant_description || data.knowledge_graph.title);
    }

    if (Array.isArray(data.organic_results)) {
        for (let i of data.organic_results.slice(0, 5)) {
            textBits.push(i.snippet);
        }
    }

    if (Array.isArray(data.related_questions)) {
        for (let i of data.related_questions.slice(0, 5)) {
            textBits.push(i.snippet);
        }
    }

    let budget = extension_settings.websearch.budget;
    let text = '';

    for (let i of textBits) {
        if (i) {
            text += i + '\n';
        }
        if (text.length > budget) {
            break;
        }
    }

    if (!text) {
        console.debug('WebSearch: search produced no text');
        return;
    }

    console.log(`WebSearch: extracted text (length = ${text.length}, budget = ${budget})`, text);

    // Save the result to cache
    if (options.useCache) {
        await storage.setItem(cacheKey, { text: text, timestamp: Date.now() });
    }

    return text;
}

window['WebSearch_Intercept'] = onWebSearchPrompt;

jQuery(async () => {
    if (!extension_settings.websearch) {
        extension_settings.websearch = structuredClone(defaultSettings);
    }

    const html = `
    <div class="websearch_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Web Search</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="flex-container flexFlowColumn">
                    <div class="flex-container alignItemsBaseline">
                        <h3 for="serpapi_key" class="flex1">
                            <a href="https://serpapi.com/" target="_blank">SerpApi Key</a>
                        </h3>
                        <div id="serpapi_key" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-key"></i>
                            <span>Click to set</span>
                        </div>
                    </div>
                    <label class="checkbox_label" for="websearch_enabled">
                        <input type="checkbox" id="websearch_enabled" />
                        <span>Enabled</span>
                    </label>
                    <label for="websearch_budget">Prompt Budget <small>(text characters)</small></label>
                    <input type="number" class="text_pole" id="websearch_budget" value="">
                    <label for="websearch_cache_lifetime">Cache Lifetime <small>(seconds)</small></label>
                    <input type="number" class="text_pole" id="websearch_cache_lifetime" value="">
                    <label for="websearch_max_words">Max Words <small>(per query)</small></label>
                    <input type="number" class="text_pole" id="websearch_max_words" value="" min="1" max="32" step="1">
                    <label for="websearch_trigger_phrases">Trigger Phrases <small>(one per line)</small></label>
                    <textarea id="websearch_trigger_phrases" class="text_pole textarea_compact" rows="2"></textarea>
                    <label for="websearch_template">Insertion Template</label>
                    <textarea id="websearch_template" class="text_pole textarea_compact autoSetHeight" rows="2" placeholder="Use {{query}} and {{text}} macro."></textarea>
                    <label for="websearch_position">Injection Position</label>
                    <div class="radio_group">
                        <label>
                            <input type="radio" name="websearch_position" value="2" />
                            Before Main Prompt / Story String
                        </label>
                        <!--Keep these as 0 and 1 to interface with the setExtensionPrompt function-->
                        <label>
                            <input type="radio" name="websearch_position" value="0" />
                            After Main Prompt / Story String
                        </label>
                        <label>
                            <input type="radio" name="websearch_position" value="1" />
                            In-chat @ Depth <input id="websearch_depth" class="text_pole widthUnset" type="number" min="0" max="999" />
                        </label>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);
    $('#websearch_enabled').prop('checked', extension_settings.websearch.enabled);
    $('#websearch_enabled').on('change', () => {
        extension_settings.websearch.enabled = !!$('#websearch_enabled').prop('checked');
        setExtensionPrompt(extensionPromptMarker, '', extension_settings.websearch.position, extension_settings.websearch.depth);
        saveSettingsDebounced();
    });
    $('#serpapi_key').toggleClass('success', !!secret_state[SECRET_KEYS.SERPAPI]);
    $('#serpapi_key').on('click', async () => {
        const key = await callPopup('<h3>Add a SerpApi key</h3>', 'input', '', { rows: 2 });

        if (key) {
            await writeSecret(SECRET_KEYS.SERPAPI, key);
        }

        $('#serpapi_key').toggleClass('success', !!secret_state[SECRET_KEYS.SERPAPI]);
    });
    $('#websearch_budget').val(extension_settings.websearch.budget);
    $('#websearch_budget').on('input', () => {
        extension_settings.websearch.budget = Number($('#websearch_budget').val());
        saveSettingsDebounced();
    });
    $('#websearch_trigger_phrases').val(extension_settings.websearch.triggerPhrases.join('\n'));
    $('#websearch_trigger_phrases').on('input', () => {
        extension_settings.websearch.triggerPhrases = String($('#websearch_trigger_phrases').val()).split('\n');
        saveSettingsDebounced();
    });
    $('#websearch_cache_lifetime').val(extension_settings.websearch.cacheLifetime);
    $('#websearch_cache_lifetime').on('input', () => {
        extension_settings.websearch.cacheLifetime = Number($('#websearch_cache_lifetime').val());
        saveSettingsDebounced();
    });
    $('#websearch_max_words').val(extension_settings.websearch.maxWords);
    $('#websearch_max_words').on('input', () => {
        extension_settings.websearch.maxWords = Number($('#websearch_max_words').val());
        saveSettingsDebounced();
    });
    $('#websearch_template').val(extension_settings.websearch.insertionTemplate);
    $('#websearch_template').on('input', () => {
        extension_settings.websearch.insertionTemplate = String($('#websearch_template').val());
        saveSettingsDebounced();
    });
    $(`input[name="websearch_position"][value="${extension_settings.websearch.position}"]`).prop('checked', true);
    $('input[name="websearch_position"]').on('change', () => {
        extension_settings.websearch.position = Number($('input[name="websearch_position"]:checked').val());
        saveSettingsDebounced();
    });
    $('#websearch_depth').val(extension_settings.websearch.depth);
    $('#websearch_depth').on('input', () => {
        extension_settings.websearch.depth = Number($('#websearch_depth').val());
        saveSettingsDebounced();
    });

    registerDebugFunction('clearWebSearchCache', 'Clear the WebSearch cache', 'Removes all search results stored in the local cache.', async () => {
        await storage.clear();
        console.log('WebSearch: cache cleared');
        toastr.success('WebSearch: cache cleared');
    });

    registerDebugFunction('testWebSearch', 'Test the WebSearch extension', 'Performs a test search using the current settings.', async () => {
        try {
            const text = prompt('Enter a test message', 'How to make a sandwich');

            if (!text) {
                return;
            }

            const result = await performSearchRequest(text, { useCache: false });
            console.log('WebSearch: test result', text, result);
            alert(result);
        } catch (error) {
            toastr.error(String(error), 'WebSearch: test failed');
        }
    });
});