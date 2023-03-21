/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	Disposable,
	Hover,
	Range
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import { Tokenize } from './cosmic/src/Lexer';
import { Parser, StatementCommon } from './cosmic/src/Parser';

import { Scope, StaticAnalysis } from './cosmic/src/StaticAnalysis';
import { typeDefinitions } from './cosmic/src/Definitions';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true
			}
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The example settings
interface ExampleSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <ExampleSettings>(
			(change.settings.languageServerExample || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'languageServerExample'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});

var doc: TextDocument | undefined = undefined;
var tokens = []
var ast: StatementCommon | undefined = undefined;
var didChangeLast = false;

let analyser = new StaticAnalysis();

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	// In this simple example we get the settings for every validate run.
	const settings = await getDocumentSettings(textDocument.uri);

	// The validator creates diagnostics for all uppercase words length 2 and more
	const text = textDocument.getText();
	doc = textDocument;
	const diagnostics: Diagnostic[] = [];
	didChangeLast = false;

	try {
		var tokensRes = Tokenize(text);
		if (!Array.isArray(tokensRes)) {
			const diagnostic: Diagnostic = {
				severity: DiagnosticSeverity.Warning,
				range: {
					start: textDocument.positionAt(tokensRes.start),
					end: textDocument.positionAt(tokensRes.end)
				},
				message: "Lexer",
				source: 'ex'
			};
			diagnostics.push(diagnostic);

			if (hasDiagnosticRelatedInformationCapability) {
				diagnostic.relatedInformation = [
					{
						location: {
							uri: textDocument.uri,
							range: Object.assign({}, diagnostic.range)
						},
						message: tokensRes.message
					}
				];
			}

			connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
			return;
		}

		var parser = new Parser(tokensRes, text, true);
		var [astRes, parseError]: any = parser.parse();

		if (parseError) {
			const diagnostic: Diagnostic = {
				severity: DiagnosticSeverity.Warning,
				range: {
					start: textDocument.positionAt(parser.errStart),
					end: textDocument.positionAt(parser.errEnd)
				},
				message: "Parser"
			};
			diagnostics.push(diagnostic);

			if (hasDiagnosticRelatedInformationCapability) {
				diagnostic.relatedInformation = [
					{
						location: {
							uri: textDocument.uri,
							range: Object.assign({}, diagnostic.range)
						},
						message: parser.errMessage
					}
				];
			}

			return;
		}

		tokens = tokensRes;
		ast = astRes;
		didChangeLast = true;

		// Type analyser
		analyser = new StaticAnalysis()
		analyser.traverse(astRes, new Scope(astRes.start, doc.getText().length))

		analyser.errors.forEach(e => {
			diagnostics.push({
				message: e.message,
				range: {
					start: textDocument.positionAt(e.start),
					end: textDocument.positionAt(e.end)
				},
				severity: e.severity
			})
		})
	}
	catch { }

	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onHover(
	(_hoverParams) => {
		if (doc == undefined || ast == undefined) return null;

		const index = doc.offsetAt(_hoverParams.position);
		const hoverables = analyser.hoverables.filter(h => index >= h.start && index <= h.end);
		if (hoverables.length == 0) return null;

		return {
			contents: hoverables[0].message
		};
	}
);

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		const completions: CompletionItem[] = [];

		// Get all the variables in the current scope
		// So functions should not see outside and vise versa

		if (doc == undefined || ast == undefined) return [];

		try {
			const index = doc.offsetAt(_textDocumentPosition.position);
			const analyser = new StaticAnalysis()
			const globalScope = analyser.traverse(ast, new Scope(ast.start, doc.getText().length))
			const currentScope = analyser.getCurrentScope(index, globalScope);

			// Show variables in scope
			if (didChangeLast && !analyser.useMember) {
				// Variables
				completions.push(...getCompletionsFromScope(currentScope));

				// Structs
				typeDefinitions.forEach(type => {
					if (type.type === "Struct") {
						completions.push({
							label: type.id,
							kind: CompletionItemKind.Struct
						})
					}
				})
			}

			// Show member properties
			else if (didChangeLast && analyser.useMember) {
				completions.push(...getCompletionsFromMember(analyser))
			}
		}
		catch (e) {
			console.log("ERROR!!")
			console.log(e);
		}

		return completions;
	}
);

const getCompletionsFromScope = (scope: Scope): CompletionItem[] => {
	var completions: CompletionItem[] = []

	// Completions from children scopes
	scope.children.forEach(child => {
		if (child === undefined) return;
		completions.push(...getCompletionsFromScope(child))
	})

	// Completions from scope variables
	scope.variables.forEach(variable => {
		completions.push({
			label: variable.id,
			kind: CompletionItemKind.Variable
		})
	})

	return completions;
}

const getCompletionsFromMember = (analyser: StaticAnalysis): CompletionItem[] => {
	var completions: CompletionItem[] = [];

	analyser.members.forEach(m => {
		if (m.type === "Method") completions.push({
			kind: CompletionItemKind.Method,
			documentation: m.details,
			label: m.id
		})

		else if (m.type === "StaticMethod") completions.push({
			kind: CompletionItemKind.Function,
			documentation: m.details,
			label: m.id
		})

		else if (m.type === "Property") completions.push({
			kind: CompletionItemKind.Property,
			label: m.id
		})
	})

	return completions
}

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		return item
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
