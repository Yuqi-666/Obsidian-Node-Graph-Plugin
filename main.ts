import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	normalizePath,
	TFile,
	TFolder,
	Vault,
} from "obsidian";
import * as fs from "fs";
import * as path from "path";

interface NodeGraphSettings {
	rootPath: string;
	tsvFolderPath: string;
	dataJsonFolderPath: string;
	canvasJsonFolderPath: string;
}
enum SyncStatus {
	Tracked = 0,
	Modified = 1
}
interface SyncJson {
	datajson: { [key: string]: SyncStatus };
	canvasjson: { [key: string]: SyncStatus };
}

interface DataNode {
	id: string;
	level: number;
	content: string;
	estimated_time: string;
	status: number;
}

interface DataEdge {
	from: string;
	to: string;
}

interface DataJson {
	nodes: DataNode[];
	edges: DataEdge[];
}

interface CanvasNode {
	id: string;
	type: string;
	text: string;
	styleAttributes: { [key: string]: any };
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
}

interface CanvasEdge {
	id: string;
	styleAttributes: { [key: string]: any };
	toFloating: boolean;
	fromFloating: boolean;
	fromNode: string;
	fromSide: string;
	toNode: string;
	toSide: string;
}

interface CanvasJson {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	metadata: {
		version: string;
		frontmatter: { [key: string]: any };
	};
}

interface LinkedListNode {
	data: DataNode;
	predecessors: string[]; // 存储前驱节点的id
	successors: string[]; // 存储后继节点的id
	size: [number, number]; // 节点宽度和高度
}

interface LinkedListGraph {
	nodes: Map<string, LinkedListNode>; // 使用Map方便通过id查找节点
}

interface SameLevelChain {
	lastnode: LinkedListNode;
	chain: LinkedListNode[];
}
interface SameLevelChainMap {
	chains: Map<number, SameLevelChain[]>;
}

interface SubgraphSize {
	parentID: string;
	width: number;
	height: number;
}

const DEFAULT_SETTINGS: NodeGraphSettings = {
	rootPath: "static/_data/OKR",
	tsvFolderPath: "tsv",
	dataJsonFolderPath: "data_json",
	canvasJsonFolderPath: "canvas_json",
};

// 从状态映射到颜色
const STATUS_TO_COLOR: { [key: number]: string } = {
	0: "0", // 未安排
	1: "5", // 进行中
	2: "4", // 已完成
};
const LEVEL_TO_COLOR: { [key: number]: string } = {
	1: "rgba(255, 0, 0, 1)", //目标
	2: "rgba(255, 165, 0, 1)", //关键成果
	3: "rgba(0, 128, 0, 1)", //任务
	4: "rgba(0, 0, 255, 1)", //子任务
};


// 字符宽度常量 (每字符像素)
const BODY_CHINESE_CHAR_WIDTH = 16;
const BODY_ALPHANUM_CHAR_WIDTH = 8;
const H1_CHINESE_CHAR_WIDTH = 30;
const H1_ALPHANUM_CHAR_WIDTH = 18;
const H2_CHINESE_CHAR_WIDTH = 26;
const H2_ALPHANUM_CHAR_WIDTH = 16;
const H3_CHINESE_CHAR_WIDTH = 24;
const H3_ALPHANUM_CHAR_WIDTH = 14;

// 节点总水平边距
const TOTAL_HORIZONTAL_MARGIN = 48;
// 节点布局参数
const NODE_HEIGHT = 60;
const KRSubgraphs_Gap = 120;
const Subgraph_KR_Gap = 120;
const TaskSubgraphs_Gap = 100;
const Subgraph_Task_Gap = 120;
const taskDefault_gap = 160;

const O_gap = 100;

const HORIZONTAL_GAP = 100; // 节点之间的水平间距
const VERTICAL_GAP = 50; // 节点之间的垂直间距
const START_X = 0;
const START_Y = 0;
/**
 * 计算字符串中汉字、字母/数字和其他字符的数量。
 * @param text 要分析的字符串。
 * @returns 包含汉字、字母/数字和其他字符数量的对象。
 */
function countCharacters(text: string): {
	chinese: number;
	alphanumeric: number;
	other: number;
} {
	let chinese = 0;
	let alphanumeric = 0;
	let other = 0;

	for (const char of text) {
		// 检查是否为汉字 (Unicode Han script)
		if (/\p{Script=Han}/u.test(char)) {
			chinese++;
		} else if (/[a-zA-Z0-9]/.test(char)) {
			alphanumeric++;
		} else {
			other++;
		}
	}
	return { chinese, alphanumeric, other };
}

export default class NodeGraphPlugin extends Plugin {
	settings: NodeGraphSettings;
	Graph: Graph = new Graph();
	syncFilePath: string = "";
	async onload() {
		await this.loadSettings();

		// 创建左侧栏图标
		const ribbonIconEl = this.addRibbonIcon(
			"network",
			"Node Graph",
			(_evt: MouseEvent) => {
				this.processFiles(); // 传递true强制重新生成JSON文件
			}
		);
		ribbonIconEl.addClass("node-graph-ribbon-class");

		// 添加设置选项卡
		this.addSettingTab(new NodeGraphSettingTab(this.app, this));
		this.syncFilePath = `${this.settings.rootPath}/syncFile.json`
		// 插件加载时处理文件
		this.processFiles();
		this.app.vault.on('modify', this.handleFileModify.bind(this));
	}

	onunload() {
		// 清理工作
		this.app.vault.off('modify', this.handleFileModify.bind(this));
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}


	async saveSettings() {
		await this.saveData(this.settings);
	}

	// 主处理函数
	async processFiles() {
		const vault = this.app.vault;

		// 确保文件夹存在
		await this.ensureFoldersExist();

		try {
			
			// 获取所有TSV文件
			const tsvFiles = await this.getFilesInFolder(
				`${this.settings.rootPath}/${this.settings.tsvFolderPath}`,
				".tsv"
			);
			

			for (const tsvFile of tsvFiles) {
				const fileName = path.basename(tsvFile, ".tsv");
				const dataJsonPath = `${this.settings.rootPath}/${this.settings.dataJsonFolderPath}/${fileName}.json`;
				const canvasJsonPath = `${this.settings.rootPath}/${this.settings.canvasJsonFolderPath}/${fileName}.canvas`;

				// 检查是否需要从TSV转换（文件不存在或强制重新生成）
				const dataJsonExists = await this.fileExists(dataJsonPath);
				if (!dataJsonExists) {
					// 从TSV转换到Data JSON
					const tsvContent = await this.readFile(tsvFile);
					const dataJson =
						this.Graph.convertTsvToDataJson(tsvContent);
					await this.writeJsonFile(dataJsonPath, dataJson);
					new Notice(`已将 ${fileName}.tsv 转换为 Data JSON`);
				}

				// 读取Data JSON
				const dataJson = await this.readJsonFile<DataJson>(
					dataJsonPath
				);

				// 检查是否需要从Data JSON转换到Canvas JSON
				const canvasJsonExists = await this.fileExists(canvasJsonPath);
				if (!canvasJsonExists) {
					// 从Data JSON转换到Canvas JSON
					const canvasJson =
						this.Graph.convertDataJsonToCanvasJson(dataJson);
					await this.writeJsonFile(canvasJsonPath, canvasJson);
					new Notice(`已将 ${fileName}.json 转换为 Canvas JSON`);
					await this.writeSyncStatus(
						this.syncFilePath,
						fileName,
						SyncStatus.Tracked,
						SyncStatus.Tracked,
					);
				}
			}

			new Notice("TSV文件处理完成");

		} catch (error) {
			console.error("处理TSV文件时出错:", error);
			// 确保显示详细的错误信息，包括行号和具体问题
			const errorMessage =
				error instanceof Error ? error.message : "未知错误";
			new Notice(`TSV文件处理失败: ${errorMessage}`);
		}
		try{
			if(!await this.fileExists(this.syncFilePath))
				return;
			let syncJson = await this.readJsonFile<SyncJson>(
						this.syncFilePath
			);
			// 使用Object.entries遍历对象字面量
			for (const [fileName, status] of Object.entries(syncJson.datajson)) {
				if (status === SyncStatus.Modified) {
					const dataJsonPath = `${this.settings.rootPath}/${this.settings.dataJsonFolderPath}/${fileName}.json`;
					const canvasJsonPath = `${this.settings.rootPath}/${this.settings.canvasJsonFolderPath}/${fileName}.canvas`;
					let dataJson = await this.readJsonFile<DataJson>(dataJsonPath);
					let canvasJson = await this.readJsonFile<CanvasJson>(canvasJsonPath);
					dataJson.nodes.forEach((node) => {
						const canvasNode = canvasJson.nodes.find(
							(n) => n.id === node.id
						);
						if (canvasNode) {
							if(node.status!==0)
								canvasNode.color = STATUS_TO_COLOR[node.status];
							else
								canvasNode.color = LEVEL_TO_COLOR[node.level];
						}
					});
					await this.writeJsonFile(canvasJsonPath, canvasJson);
				}
				await this.writeSyncStatus(
						this.syncFilePath,
					fileName,
					SyncStatus.Tracked,
					SyncStatus.Tracked,
				);
			}
			// 使用Object.entries遍历canvasjson对象字面量
			for (const [fileName, status] of Object.entries(syncJson.canvasjson)) {
				if (status === SyncStatus.Modified) {
					const dataJsonPath = `${this.settings.rootPath}/${this.settings.dataJsonFolderPath}/${fileName}.json`;
					const canvasJsonPath = `${this.settings.rootPath}/${this.settings.canvasJsonFolderPath}/${fileName}.canvas`;
					let dataJson = await this.readJsonFile<DataJson>(dataJsonPath);
					let canvasJson = await this.readJsonFile<CanvasJson>(canvasJsonPath);
					canvasJson.nodes.forEach((node) => {
						const dataNode = dataJson.nodes.find(
							(n) => n.id === node.id
						);
						if (dataNode) {
							let color = node.color;
							for(let status in STATUS_TO_COLOR){
								if(STATUS_TO_COLOR[status]===color){
									dataNode.status = parseInt(status);
									break;
								}
							}
							
							
							for(let level in LEVEL_TO_COLOR){
								if(LEVEL_TO_COLOR[level]===node.color){
									dataNode.level = parseInt(level);
									break;
								}
							}
							dataNode.content = node.text;
						}else{
							let color = node.color;
							let Nodestatus = 0;
							let Nodelevel = 0;
							for(let status in STATUS_TO_COLOR){
								if(STATUS_TO_COLOR[status]===color){
									Nodestatus = parseInt(status);
									break;
								}
							}
							for(let level in LEVEL_TO_COLOR){
								if(LEVEL_TO_COLOR[level]===node.color){
									Nodelevel = parseInt(level);
									break;
								}
							}
							
							let dataNode :DataNode = {
								id: node.id,
								level: Nodelevel,
								content: node.text,
								estimated_time: '',
								status: Nodestatus
							};
							dataJson.nodes.push(dataNode);
						}
					});
					canvasJson.edges.forEach((edge) => {
						const dataEdge = dataJson.edges.find(
							(e) => e.from === edge.fromNode && e.to === edge.toNode
						);
						if (!dataEdge) {
							dataJson.edges.push({
								
								from: edge.fromNode,
								to: edge.toNode,
								
							});
						}
					});
					await this.writeJsonFile(dataJsonPath, dataJson);
				}
				await this.writeSyncStatus(
						this.syncFilePath,
					fileName,
					SyncStatus.Tracked,
					SyncStatus.Tracked,
				);
			};


		}catch (error) {
			console.error("同步文件时出错:", error);
			// 确保显示详细的错误信息，包括行号和具体问题
			const errorMessage =
				error instanceof Error ? error.message : "未知错误";
			new Notice(`同步文件失败: ${errorMessage}`);
		}
	}
	async writeSyncStatus(
		syncFilePath: string,
		fileName: string,
		datajsonStatus: SyncStatus,
		canvasjsonStatus: SyncStatus,
	) {
		const syncFileExists = await this.fileExists(syncFilePath);
		let syncJson: SyncJson;
		if (!syncFileExists) {
			syncJson = {
				datajson: {},
				canvasjson: {},
			};

		}else{
			syncJson = await this.readJsonFile<SyncJson>(
				syncFilePath
			);}
		new Notice(`文件 ${fileName} 已writeSyncStatus`);
		// 使用对象字面量而不是Map
		syncJson.datajson[fileName] = datajsonStatus;
		syncJson.canvasjson[fileName] = canvasjsonStatus;
		await this.writeJsonFile(syncFilePath, syncJson);
	}

	async handleFileModify(file: TFile) {
		// new Notice(`文件 ${file.path} 已修改`);
		new Notice(`${this.settings.rootPath}/${this.settings.dataJsonFolderPath}`);
		if(file.path.startsWith(`${this.settings.rootPath}/${this.settings.dataJsonFolderPath}`)){
			let fileName = file.basename.split(".")[0];
			await this.writeSyncStatus(
					this.syncFilePath,
				fileName,
				SyncStatus.Modified,
				SyncStatus.Tracked,
			);
		}else if(file.path.startsWith(`${this.settings.rootPath}/${this.settings.canvasJsonFolderPath}`)){
			let fileName = file.basename.split(".")[0];
			await this.writeSyncStatus(
					this.syncFilePath,
				fileName,
				SyncStatus.Tracked,
				SyncStatus.Modified,
			);
		}
	}
	// 确保文件夹存在
	async ensureFoldersExist() {
		const vault = this.app.vault;

		// 确保TSV文件夹存在
		await this.ensureFolderExists(this.settings.tsvFolderPath);

		// 确保Data JSON文件夹存在
		await this.ensureFolderExists(this.settings.dataJsonFolderPath);

		// 确保Canvas JSON文件夹存在
		await this.ensureFolderExists(this.settings.canvasJsonFolderPath);
	}

	// 确保单个文件夹存在
	async ensureFolderExists(folderPath: string) {
		const vault = this.app.vault;
		const normalizedPath = normalizePath(folderPath);
		const folder = vault.getAbstractFileByPath(normalizedPath);

		if (!folder) {
			await vault.createFolder(normalizedPath);
		} else if (!(folder instanceof TFolder)) {
			throw new Error(`${folderPath} 已存在但不是文件夹`);
		}
	}

	// 获取文件夹中的所有指定类型的文件
	async getFilesInFolder(
		folderPath: string,
		extension: string
	): Promise<string[]> {
		const vault = this.app.vault;
		const normalizedPath = normalizePath(folderPath);
		const folder = vault.getAbstractFileByPath(normalizedPath);

		if (!folder || !(folder instanceof TFolder)) {
			return [];
		}

		const files: string[] = [];
		this.collectFiles(folder, extension, files);
		return files;
	}

	// 递归收集文件
	collectFiles(folder: TFolder, extension: string, files: string[]): void {
		for (const file of folder.children) {
			if (file instanceof TFile && file.path.endsWith(extension)) {
				files.push(file.path);
			} else if (file instanceof TFolder) {
				this.collectFiles(file, extension, files);
			}
		}
	}

	// 检查文件是否存在
	async fileExists(filePath: string): Promise<boolean> {
		const vault = this.app.vault;
		const normalizedPath = normalizePath(filePath);
		return vault.getAbstractFileByPath(normalizedPath) instanceof TFile;
	}

	// 读取文件内容
	async readFile(filePath: string): Promise<string> {
		const vault = this.app.vault;
		const normalizedPath = normalizePath(filePath);
		const file = vault.getAbstractFileByPath(normalizedPath);

		if (!(file instanceof TFile)) {
			throw new Error(`文件不存在: ${filePath}`);
		}

		return await vault.read(file);
	}

	// 读取JSON文件
	async readJsonFile<T>(filePath: string): Promise<T> {
		const content = await this.readFile(filePath);
		return JSON.parse(content) as T;
	}

	// 写入JSON文件
	async writeJsonFile(filePath: string, data: any): Promise<void> {
		const vault = this.app.vault;
		const normalizedPath = normalizePath(filePath);
		const content = JSON.stringify(data, null, 2);

		const file = vault.getAbstractFileByPath(normalizedPath);
		if (file instanceof TFile) {
			await vault.modify(file, content);
		} else {
			await vault.create(normalizedPath, content);
		}
	}
}

class NodeGraphSettingTab extends PluginSettingTab {
	plugin: NodeGraphPlugin;

	constructor(app: App, plugin: NodeGraphPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.createEl("h2", { text: "Node Graph 设置" });

		new Setting(containerEl)
			.setName("根文件夹路径")
			.setDesc("存放数据的文件夹路径")
			.addText((text) =>
				text
					.setPlaceholder("static/_data/OKR")
					.setValue(this.plugin.settings.rootPath)
					.onChange(async (value) => {
						this.plugin.settings.rootPath = value;
						await this.plugin.saveSettings();
					})
			);
		// TSV文件夹路径设置
		new Setting(containerEl)
			.setName("TSV文件夹路径")
			.setDesc("存放TSV文件的文件夹路径")
			.addText((text) =>
				text
					.setPlaceholder("tsv")
					.setValue(this.plugin.settings.tsvFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.tsvFolderPath = value;
						await this.plugin.saveSettings();
					})
			);

		// Data JSON文件夹路径设置
		new Setting(containerEl)
			.setName("Data JSON文件夹路径")
			.setDesc("存放Data JSON文件的文件夹路径")
			.addText((text) =>
				text
					.setPlaceholder("data_json")
					.setValue(this.plugin.settings.dataJsonFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.dataJsonFolderPath = value;
						await this.plugin.saveSettings();
					})
			);

		// Canvas JSON文件夹路径设置
		new Setting(containerEl)
			.setName("Canvas JSON文件夹路径")
			.setDesc("存放Canvas JSON文件的文件夹路径")
			.addText((text) =>
				text
					.setPlaceholder("canvas_json")
					.setValue(this.plugin.settings.canvasJsonFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.canvasJsonFolderPath = value;
						await this.plugin.saveSettings();
					})
			);
	}
}

class Graph {
	graph: LinkedListGraph = {
		nodes: new Map(),
	};
	
	sameLevelChainMap: SameLevelChainMap = {
		chains: new Map(),
	};
	// 将TSV转换为Data JSON
	convertTsvToDataJson(tsvContent: string): DataJson {
		// 分割两个表
		// 使用正则表达式分割，允许分隔符周围有空白字符
		const tables = tsvContent.split(/\s*\*{6}\s*/);
		if (tables.length < 2) {
			throw new Error("TSV文件格式不正确，缺少分隔符******");
		}

		// 解析节点表
		const nodesTable = tables[0].trim();
		const nodeLines = nodesTable.split("\n");
		const nodeHeaders = nodeLines[0]?.split("\t");
		const nodes: DataNode[] = [];

		// 确保有表头和至少一行数据
		if (nodeHeaders && nodeHeaders.length >= 4 && nodeLines.length > 1) {
			for (let i = 1; i < nodeLines.length; i++) {
				const line = nodeLines[i].trim();
				if (line) {
					const values = line.split("\t");
					// 严格检查字段数量，缺少时抛出错误并指明行号
					if (values.length < 4) {
						for (const value of values) {
							new Notice(`节点表第${i + 1}行字段值: ${value}`);
						}
						throw new Error(
							`节点表第${i + 1
							}行格式错误：缺少必要字段，需要至少4个字段（id, level, content, estimated_time）`
						);
					}

					// 检查level是否为有效数字
					const levelValue = parseInt(values[1], 10);
					if (isNaN(levelValue)) {
						throw new Error(
							`节点表第${i + 1
							}行格式错误：level字段必须是有效数字`
						);
					}

					// 确保所有必需字段存在且不为空
					if (!values[0] || !values[2] || !values[3]) {
						throw new Error(
							`节点表第${i + 1
							}行格式错误：id、content或estimated_time字段不能为空`
						);
					}

					const node: DataNode = {
						id: values[0],
						level: levelValue,
						content: values[2],
						estimated_time: values[3],
						status: 0, // 初始状态为未安排
					};
					nodes.push(node);
				}
			}
		}

		// 解析边表
		const edgesTable = tables[1].trim();
		const edgeLines = edgesTable.split("\n");
		const edgeHeaders = edgeLines[0]?.split("\t");
		const edges: DataEdge[] = [];

		// 确保有表头和至少一行数据
		if (edgeHeaders && edgeHeaders.length >= 2 && edgeLines.length > 1) {
			for (let i = 1; i < edgeLines.length; i++) {
				const line = edgeLines[i].trim();
				if (line) {
					const values = line.split("\t");
					// 严格检查字段数量，缺少时抛出错误并指明行号
					if (values.length < 2) {
						throw new Error(
							`边表第${i + 1
							}行格式错误：缺少必要字段，需要至少2个字段（from, to）`
						);
					}

					edges.push({
						from: values[0],
						to: values[1],
					});
				}
			}
		}

		return { nodes, edges };
	}

	// 将Data JSON转换为Canvas JSON
	convertDataJsonToCanvasJson(dataJson: DataJson): CanvasJson {
		let canvasNodes: CanvasNode[] = [];
		let canvasEdges: CanvasEdge[] = [];

		// 将DataJson转换为LinkedListGraph以便进行层级遍历
		this.graph = this.convertDataJsonToLinkedListGraph(dataJson);

		// 预计算并缓存所有节点的宽高，便于后续布局与渲染使用
		this.calculateAllNodeSizes();

		//遍历rootNodes，将它们添加到canvasNodes中
		const rootNodes: LinkedListNode[] = [];
		this.graph.nodes.forEach((node, id) => {
			if (node.data.level === 1) {
				rootNodes.push(node);
				this.getSameLevelMap(node).forEach((chains, level) => {
					this.sameLevelChainMap.chains.set(level, chains);
				});
			}
		});
		canvasNodes = canvasNodes.concat(this.canvasAddNodeFromRoot(canvasNodes, rootNodes));
		canvasEdges = canvasEdges.concat(this.canvasAddEdgeFromRoot(canvasEdges, rootNodes));
		return {
			nodes: canvasNodes,
			edges: canvasEdges,
			metadata: {
				version: "1.0-1.0",
				frontmatter: {},
			},
		};
	}

	canvasAddEdgeFromRoot(canvasEdges: CanvasEdge[], rootNodes: LinkedListNode[]): CanvasEdge[] {
		//创建边
		for (let i = 0; i < rootNodes.length; i++) {
			rootNodes[i].predecessors.forEach((predecessor) => {
				let predecessornode =
					this.graph.nodes.get(predecessor);
				if (predecessornode?.data.level === rootNodes[i].data.level + 1)
					canvasEdges.push({
						id: `${predecessor}_${rootNodes[i].data.id}`,
						styleAttributes: {},
						toFloating: false,
						fromFloating: false,
						fromNode: predecessornode?.data.id,
						fromSide: "right",
						toNode: rootNodes[i].data.id,
						toSide: "left",
					});
			});
		}
		let map = this.sameLevelChainMap;
		let directionMap = new Map([
			[1, ["right", "left"]],
			[2, ["right", "left"]],
			[3, ["top", "bottom"]],
		]);
		for (const [level, chains] of map.chains) {
			if (level === 4) {
				continue;
			} else {
				chains.forEach((chain) => {
					for (let i = 0; i < chain.chain.length; i++) {
						if (i !== chain.chain.length - 1)
							canvasEdges.push({
								id: `${chain.chain[i + 1].data.id}_${chain.chain[i].data.id}`,
								styleAttributes: {},
								toFloating: false,
								fromFloating: false,
								fromNode: chain.chain[i + 1].data.id,
								fromSide: directionMap.get(level)?.[0] ?? "right",
								toNode: chain.chain[i].data.id,
								toSide: directionMap.get(level)?.[1] ?? "left",
							});
						chain.chain[i].predecessors.forEach((predecessor) => {
							let predecessornode =
								this.graph.nodes.get(predecessor);
							if (predecessornode?.data.level === level + 1)
								if (level + 1 === 4) {
									if (i % 2 === 0) {
										canvasEdges.push({
											id: `${predecessor}_${chain.chain[i].data.id}`,
											styleAttributes: {},
											toFloating: false,
											fromFloating: false,
											fromNode: predecessornode?.data.id,
											fromSide: "right",
											toNode: chain.chain[i].data.id,
											toSide: "left",
										});
									} else {
										canvasEdges.push({
											id: `${predecessor}_${chain.chain[i].data.id}`,
											styleAttributes: {},
											toFloating: false,
											fromFloating: false,
											fromNode: predecessornode?.data.id,
											fromSide: "left",
											toNode: chain.chain[i].data.id,
											toSide: "right",
										});
									}
								} else
									canvasEdges.push({
										id: `${predecessor}_${chain.chain[i].data.id}`,
										styleAttributes: {},
										toFloating: false,
										fromFloating: false,
										fromNode: predecessornode?.data.id,
										fromSide:
											directionMap.get(level + 1)?.[0] ??
											"left",
										toNode: chain.chain[i].data.id,
										toSide:
											directionMap.get(level + 1)?.[1] ??
											"right",
									});
						});
					}
				});
			}
		}
		return canvasEdges;
	}
	canvasAddNodeFromRoot(
		canvasNodes: CanvasNode[],
		rootNodes: LinkedListNode[]

	): CanvasNode[] {

		let O_X = START_X;
		let O_Y = START_Y;
		for (let i = 0; i < rootNodes.length; i++) {
			if (i > 0) {
				let temp = this.calculateSubGraphSize(rootNodes[i - 1])[0];
				if (typeof temp === "number") {
					O_Y += temp + O_gap;
				}
			}
			canvasNodes.push({
				id: rootNodes[i].data.id,
				type: "text",
				text:
					rootNodes[i].data.level > 0 && rootNodes[i].data.level <= 3
						? "#".repeat(rootNodes[i].data.level) +
						" " +
						rootNodes[i].data.content
						: rootNodes[i].data.content,
				styleAttributes: { textAlign: "center" },
				x: O_X,
				y: O_Y,
				// 优先使用预计算的尺寸，缺失时退回到即时计算
				width:
					this.graph.nodes.get(rootNodes[i].data.id)?.size[0] ??
					this.calculateNodeWidth(rootNodes[i].data),
				height: NODE_HEIGHT,
				color: rootNodes[i].data.status===0?LEVEL_TO_COLOR[rootNodes[i].data.level]:STATUS_TO_COLOR[rootNodes[i].data.status],
			});


			//遍历KR
			let KR_X = O_X;
			let KR_Y = O_Y;
			for (const predecessor of rootNodes[i].predecessors) {
				let tempNode = this.graph.nodes.get(predecessor);
				if (tempNode?.data.level == rootNodes[i].data.level + 1) {
					let samelevelchain = this.sameLevelChainMap.chains.get(tempNode.data.level)
						?.find((chain) => chain.lastnode === tempNode)?.chain;

					if (samelevelchain) {
						for (let j = 0; j < samelevelchain.length; j++) {
							let Subgraph = this.calculateSubGraphSize(
								samelevelchain[j]
							)[0] as number[];
							if (j === 0) {
								KR_X -= samelevelchain[j].size[0] / 2;
							}
							KR_X -= KRSubgraphs_Gap + Subgraph[1];

							if (j > 0) {
								let preSubgraph =
									this.calculateSubGraphSize(
										samelevelchain[j - 1]
									)[0] as number[];
								KR_X -= preSubgraph[0];
							}

							canvasNodes.push({
								id: samelevelchain[j].data.id,
								type: "text",
								text:
									samelevelchain[j].data.level > 0 &&
										samelevelchain[j].data.level <= 3
										? "#".repeat(
											samelevelchain[j].data.level
										) +
										" " +
										samelevelchain[j].data.content
										: samelevelchain[j].data.content,
								styleAttributes: { textAlign: "center" },
								x: KR_X,
								y: KR_Y,
								// 优先使用预计算的尺寸，缺失时退回到即时计算
								width:
									this.graph.nodes.get(
										samelevelchain[j].data.id
									)?.size[0] ??
									this.calculateNodeWidth(
										samelevelchain[j].data
									),
								height: NODE_HEIGHT,
								color: samelevelchain[j].data.status===0?LEVEL_TO_COLOR[samelevelchain[j].data.level]:STATUS_TO_COLOR[samelevelchain[j].data.status],
							});

							let task_gap: number[] = [taskDefault_gap];
							let middle =
								KR_X +
								this.graph.nodes.get(samelevelchain[j].data.id)
									.size[0] /
								2;
							let Task_Y = 0;
							//遍历Task
							for (const predecessor of samelevelchain[j]
								.predecessors) {
								let tempNode =
									this.graph.nodes.get(predecessor);
								if (
									tempNode?.data.level ==
									samelevelchain[j].data.level + 1
								) {
									let samelevelchain =
										this.sameLevelChainMap.chains.get(tempNode.data.level)
											?.find(
												(chain) =>
													chain.lastnode === tempNode
											)?.chain;
									if (samelevelchain) {
										for (
											let k = 0;
											k < samelevelchain.length;
											k++
										) {
											let task_width =
												this.graph.nodes.get(
													samelevelchain[k].data.id
												)?.size[0] ??
												this.calculateNodeWidth(
													samelevelchain[k].data
												);
											let Task_X =
												middle -
												this.graph.nodes.get(
													samelevelchain[k].data.id
												)?.size[0] /
												2;
											let tempgap =
												this.calculateSubGraphSize(
													samelevelchain[k]
												)[1] +
												TaskSubgraphs_Gap -
												task_gap[k];
											if (tempgap < taskDefault_gap) {
												tempgap = taskDefault_gap;
											}
											task_gap.push(
												tempgap
											);
											if (k === 0)
												Task_Y = KR_Y + Subgraph_KR_Gap;
											else if (k > 0) {
												Task_Y += task_gap[k - 1];
											}
											canvasNodes.push({
												id: samelevelchain[k].data.id,
												type: "text",
												text:
													samelevelchain[k].data
														.level > 0 &&
														samelevelchain[k].data
															.level <= 3
														? "#".repeat(
															samelevelchain[
																k
															].data.level
														) +
														" " +
														samelevelchain[k].data
															.content
														: samelevelchain[k].data
															.content,
												styleAttributes: {
													textAlign: "center",
												},
												x: Task_X,
												y: Task_Y,
												// 优先使用预计算的尺寸，缺失时退回到即时计算
												width: task_width,

												height: NODE_HEIGHT,
												color: samelevelchain[k].data.status===0?LEVEL_TO_COLOR[samelevelchain[k].data.level]:STATUS_TO_COLOR[samelevelchain[k].data.status],		
											});
											let subtask_size = this.calculateSubGraphSize(
												samelevelchain[k]
											);
											let SubTask_X = 0;
											let SubTask_Y = Task_Y + subtask_size[1] - NODE_HEIGHT;
											let subtask_width =
												subtask_size[0] as number;
											//遍历SubTask
											for (const predecessor of samelevelchain[
												k
											].predecessors) {
												let tempNode =
													this.graph.nodes.get(
														predecessor
													);
												if (
													tempNode?.data.level ==
													samelevelchain[k].data
														.level +
													1
												) {
													let samelevelchain =
														this.sameLevelChainMap.chains.get(
															tempNode.data
																.level
														)
															?.find(
																(chain) =>
																	chain.lastnode ===
																	tempNode
															)?.chain;
													if (samelevelchain)
														for (
															let l = 0;
															l <
															samelevelchain.length;
															l++
														) {
															if (k % 2 === 0) {
																SubTask_X =
																	middle -
																	task_width /
																	2 -
																	Subgraph_Task_Gap -
																	subtask_width;
															} else {
																SubTask_X =
																	middle +
																	task_width /
																	2 +
																	Subgraph_Task_Gap;
															}
															if (l > 0)
																SubTask_Y -=
																	NODE_HEIGHT;
															canvasNodes.push({
																id: samelevelchain[
																	l
																].data.id,
																type: "text",
																text:
																	samelevelchain[
																		l
																	].data
																		.level >
																		0 &&
																		samelevelchain[
																			l
																		].data
																			.level <=
																		3
																		? "#".repeat(
																			samelevelchain[
																				l
																			]
																				.data
																				.level
																		) +
																		" " +
																		samelevelchain[
																			l
																		].data
																			.content
																		: samelevelchain[
																			l
																		].data
																			.content,
																styleAttributes:
																{
																},
																x: SubTask_X,
																y: SubTask_Y,
																// 优先使用预计算的尺寸，缺失时退回到即时计算
																width:
																	this.graph.nodes.get(
																		samelevelchain[
																			l
																		].data
																			.id
																	)
																		?.size[0] ??
																	this.calculateNodeWidth(
																		samelevelchain[
																			l
																		].data
																	),
																height: NODE_HEIGHT,
																color: samelevelchain[l].data.status===0?LEVEL_TO_COLOR[samelevelchain[l].data.level]:STATUS_TO_COLOR[samelevelchain[l].data.status],	
															});
														}
												}
											}
										}
									}
								} else {
									continue;
								}
							}
						}
					}
				}
			}
		}
		return canvasNodes;
	}

	getSameLevelChain(lastnode: LinkedListNode): SameLevelChain {
		let SameLevelChain: SameLevelChain = {
			lastnode: lastnode,
			chain: [],
		};
		let queue: (LinkedListNode | undefined)[] = [];
		queue.push(lastnode);
		while (queue.length > 0) {
			let tempNode = queue.shift();
			if (!tempNode) continue;
			for (const predecessor of tempNode.predecessors) {
				let tempNode = this.graph.nodes.get(predecessor);
				if (tempNode?.data.level == lastnode.data.level) {
					queue.push(tempNode);
				} else {
					continue;
				}
			}
			SameLevelChain.chain.push(tempNode);
		}
		return SameLevelChain;
	}
	getSameLevelMap(root: LinkedListNode): Map<number, SameLevelChain[]> {
		let SameLevelMap = new Map<number, SameLevelChain[]>();
		let queue: (LinkedListNode | undefined)[] = [];
		queue.push(root);
		while (queue.length > 0) {
			let tempNode = queue.shift();
			if (!tempNode) continue;
			for (const predecessor of tempNode.predecessors) {
				let tempLastNode = this.graph.nodes.get(predecessor);
				if (tempLastNode?.data.level == tempNode.data.level + 1) {
					let SameLevelChain = this.getSameLevelChain(tempLastNode);
					SameLevelMap.set(
						tempLastNode.data.level,
						(SameLevelMap.get(tempLastNode.data.level) ?? [])
							.concat([SameLevelChain])
					);
					if (tempLastNode.data.level < 4)
						SameLevelChain.chain.forEach((node) => {
							queue.push(node);
						});
				} else {
					continue;
				}
			}
		}
		return SameLevelMap;
	}

	calculateSubGraphSize(
		node: LinkedListNode
	): [number | [number, number], number] {
		if (node.data.level === 1) {
			let subgraphSize: SubgraphSize[] = [];
			for (const predecessor of node.predecessors) {
				let tempLastNode = this.graph.nodes.get(predecessor);
				if (tempLastNode?.data.level == node.data.level + 1) {
					this.sameLevelChainMap.chains
						.get(tempLastNode.data.level)
						?.find((chain) => chain.lastnode === tempLastNode)
						?.chain.forEach((node) => {
							let [width, height] =
								this.calculateSubGraphSize(node);
							if (typeof width === "object")
								subgraphSize.push({
									parentID: node.data.id,
									width: width[0] + width[1],
									height: height,
								});
						});
				} else {
					continue;
				}
			}
			let width = 0;
			let height = 0;
			for (const subgraph of subgraphSize) {
				width += subgraph.width;
				width += KRSubgraphs_Gap;
			}
			height =
				Math.max(...subgraphSize.map((subgraph) => subgraph.height)) +
				NODE_HEIGHT +
				Subgraph_KR_Gap;
			return [width, height];
		} else if (node.data.level === 2) {
			let subgraphSize: SubgraphSize[] = [];
			let task_gap: number[] = [taskDefault_gap];
			let subtask_task_width_left: number[] = [];
			let subtask_task_width_right: number[] = [];
			let height = 0;
			for (const predecessor of node.predecessors) {
				let tempLastNode = this.graph.nodes.get(predecessor);
				if (tempLastNode?.data.level == node.data.level + 1) {
					let nodelist = this.sameLevelChainMap.chains
						.get(tempLastNode.data.level)
						?.find(
							(chain) => chain.lastnode === tempLastNode
						)?.chain;
					if (!nodelist) continue;

					for (let i = 0; i < nodelist?.length; i++) {
						if (i > 0) {
							if (i % 2 === 0) {
								subtask_task_width_right.push(
									subgraphSize[i - 1].width +
									Subgraph_Task_Gap +
									Math.max(
										nodelist[i].size[0],
										nodelist[i - 1].size[0]
									) /
									2
								);
							} else {
								subtask_task_width_left.push(
									subgraphSize[i - 1].width +
									Subgraph_Task_Gap +
									Math.max(
										nodelist[i].size[0],
										nodelist[i - 1].size[0]
									) /
									2
								);
							}
						}
						let [subwidth, subheight] =
							this.calculateSubGraphSize(nodelist[i]);
						if (typeof subwidth === "number")
							subgraphSize.push({
								parentID: node.data.id,
								width: subwidth,
								height: subheight,
							});
						let tempgap: number =
							subheight + TaskSubgraphs_Gap - task_gap[i];
						task_gap.push(tempgap);
						if (i === nodelist?.length - 1) {
							for (let i = 0; i < task_gap.length - 2; i++) {
								height += task_gap[i];
							}
							height += subheight;
							if (i % 2 === 0) {
								subtask_task_width_left.push(
									subgraphSize[i].width +
									Subgraph_Task_Gap +
									nodelist[i].size[0] / 2
								);
							} else {
								subtask_task_width_right.push(
									subgraphSize[i].width +
									Subgraph_Task_Gap +
									nodelist[i].size[0] / 2
								);
							}
						}
					}
				}
			}
			let widt_left = Math.max(...subtask_task_width_left);
			let widt_right = Math.max(...subtask_task_width_right);
			return [[widt_left, widt_right], height];
		} else if (node.data.level === 3) {
			let widths: number[] = [];
			for (const predecessor of node.predecessors) {
				let tempLastNode = this.graph.nodes.get(predecessor);
				if (tempLastNode?.data.level == node.data.level + 1) {
					this.sameLevelChainMap.chains
						.get(tempLastNode.data.level)
						?.find((chain) => chain.lastnode === tempLastNode)
						?.chain.forEach((node) => {
							widths.push(node.size[0]);
						});
				} else {
					continue;
				}
			}
			let width = 0;
			let height = 0;
			height = NODE_HEIGHT * widths.length;
			width = Math.max(...widths);
			return [width, height];
		} else {
			return [0, 0];
		}
	}

	calculateNodeWidth(node: DataNode): number {
		const { chinese, alphanumeric } = countCharacters(node.content);
		let currentChineseCharWidth = BODY_CHINESE_CHAR_WIDTH;
		let currentAlphanumCharWidth = BODY_ALPHANUM_CHAR_WIDTH;

		switch (node.level) {
			case 0:
				currentChineseCharWidth = H1_CHINESE_CHAR_WIDTH;
				currentAlphanumCharWidth = H1_ALPHANUM_CHAR_WIDTH;
				break;
			case 1:
				currentChineseCharWidth = H2_CHINESE_CHAR_WIDTH;
				currentAlphanumCharWidth = H2_ALPHANUM_CHAR_WIDTH;
				break;
			case 2:
				currentChineseCharWidth = H3_CHINESE_CHAR_WIDTH;
				currentAlphanumCharWidth = H3_ALPHANUM_CHAR_WIDTH;
				break;
			default:
				// 默认使用正文宽度
				break;
		}

		const calculatedWidth =
			chinese * currentChineseCharWidth +
			alphanumeric * currentAlphanumCharWidth +
			TOTAL_HORIZONTAL_MARGIN;
		return Math.max(120, calculatedWidth); // 确保最小宽度
	}

	convertDataJsonToLinkedListGraph(dataJson: DataJson): LinkedListGraph {
		// 创建节点映射
		const nodeMap = new Map<string, LinkedListNode>();
		dataJson.nodes.forEach((node) => {
			nodeMap.set(node.id, {
				data: node,
				predecessors: [],
				successors: [],
				size: [0, 0],
			});
		});

		// 填充前驱和后继关系
		dataJson.edges.forEach((edge) => {
			const fromNode = nodeMap.get(edge.from);
			const toNode = nodeMap.get(edge.to);
			if (fromNode && toNode) {
				fromNode.successors.push(edge.to);
				toNode.predecessors.push(edge.from);
			}
		});

		return {
			nodes: nodeMap,
		};
	}

	calculateAllNodeSizes(): void {
		if (!this.graph || !this.graph.nodes) return;
		this.graph.nodes.forEach((llNode) => {
			const width = this.calculateNodeWidth(llNode.data);
			llNode.size = [width, NODE_HEIGHT];
		});
	}
}
