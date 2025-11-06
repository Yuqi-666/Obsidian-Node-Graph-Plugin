import { App, Notice, Plugin, PluginSettingTab, Setting, normalizePath, TFile, TFolder, Vault } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';

interface NodeGraphSettings {
	tsvFolderPath: string;
	dataJsonFolderPath: string;
	canvasJsonFolderPath: string;
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
	styleAttributes: {[key: string]: any};
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
}

interface CanvasEdge {
	id: string;
	styleAttributes: {[key: string]: any};
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
		frontmatter: {[key: string]: any};
	};
}

const DEFAULT_SETTINGS: NodeGraphSettings = {
	tsvFolderPath: 'tsv',
	dataJsonFolderPath: 'data_json',
	canvasJsonFolderPath: 'canvas_json'
};

// 从状态映射到颜色
const STATUS_TO_COLOR: {[key: number]: string} = {
	0: '0',  // 未安排
	1: '5',  // 进行中
	2: '4'   // 已完成
};

export default class NodeGraphPlugin extends Plugin {
	settings: NodeGraphSettings;

	async onload() {
		await this.loadSettings();

		// 创建左侧栏图标
		const ribbonIconEl = this.addRibbonIcon('network', 'Node Graph', (_evt: MouseEvent) => {
			this.processFiles(true); // 传递true强制重新生成JSON文件
		});
		ribbonIconEl.addClass('node-graph-ribbon-class');

		// 添加设置选项卡
		this.addSettingTab(new NodeGraphSettingTab(this.app, this));

		// 插件加载时处理文件
		this.processFiles();
	}

	onunload() {
		// 清理工作
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// 主处理函数
	async processFiles(forceRegenerate = false) {
		try {
			const vault = this.app.vault;
			
			// 确保文件夹存在
			await this.ensureFoldersExist();
			
			// 获取所有TSV文件
			const tsvFiles = await this.getFilesInFolder(this.settings.tsvFolderPath, '.tsv');
			
			for (const tsvFile of tsvFiles) {
				const fileName = path.basename(tsvFile, '.tsv');
				const dataJsonPath = `${this.settings.dataJsonFolderPath}/${fileName}.json`;
				const canvasJsonPath = `${this.settings.canvasJsonFolderPath}/${fileName}.canvas`;
				
				// 检查是否需要从TSV转换（文件不存在或强制重新生成）
				const dataJsonExists = await this.fileExists(dataJsonPath);
				if (!dataJsonExists || forceRegenerate) {
					// 从TSV转换到Data JSON
					const tsvContent = await this.readFile(tsvFile);
					const dataJson = this.convertTsvToDataJson(tsvContent);
					await this.writeJsonFile(dataJsonPath, dataJson);
					new Notice(`已将 ${fileName}.tsv 转换为 Data JSON`);
				}
				
				// 读取Data JSON
				const dataJson = await this.readJsonFile<DataJson>(dataJsonPath);
				
				// 检查是否需要从Data JSON转换到Canvas JSON
				const canvasJsonExists = await this.fileExists(canvasJsonPath);
				if (!canvasJsonExists) {
					// 从Data JSON转换到Canvas JSON
					const canvasJson = this.convertDataJsonToCanvasJson(dataJson);
					await this.writeJsonFile(canvasJsonPath, canvasJson);
					new Notice(`已将 ${fileName}.json 转换为 Canvas JSON`);
				} else {
					// 同步Data JSON和Canvas JSON
					await this.syncJsonFiles(dataJsonPath, canvasJsonPath);
				}
			}
			
			new Notice('Node Graph 处理完成');
		} catch (error) {
			console.error('处理文件时出错:', error);
			// 确保显示详细的错误信息，包括行号和具体问题
			const errorMessage = error instanceof Error ? error.message : '未知错误';
			new Notice(`Node Graph 处理失败: ${errorMessage}`);
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
	async getFilesInFolder(folderPath: string, extension: string): Promise<string[]> {
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

	// 将TSV转换为Data JSON
	convertTsvToDataJson(tsvContent: string): DataJson {
		// 分割两个表
		// 使用正则表达式分割，允许分隔符周围有空白字符
		const tables = tsvContent.split(/\s*\*{6}\s*/);
		if (tables.length < 2) {
			throw new Error('TSV文件格式不正确，缺少分隔符******');
		}
		
		// 解析节点表
		const nodesTable = tables[0].trim();
		const nodeLines = nodesTable.split('\n');
		const nodeHeaders = nodeLines[0]?.split('\t');
		const nodes: DataNode[] = [];
		
		// 确保有表头和至少一行数据
		if (nodeHeaders && nodeHeaders.length >= 4 && nodeLines.length > 1) {
			for (let i = 1; i < nodeLines.length; i++) {
				const line = nodeLines[i].trim();
				if (line) {
					const values = line.split('\t');
					// 严格检查字段数量，缺少时抛出错误并指明行号
					if (values.length < 4) {
						for(const value of values){
							new Notice(`节点表第${i+1}行字段值: ${value}`);
						}
						throw new Error(`节点表第${i+1}行格式错误：缺少必要字段，需要至少4个字段（id, level, content, estimated_time）`);
						
					}
					
					// 检查level是否为有效数字
					const levelValue = parseInt(values[1], 10);
					if (isNaN(levelValue)) {
						throw new Error(`节点表第${i+1}行格式错误：level字段必须是有效数字`);
					}
					
					// 确保所有必需字段存在且不为空
					if (!values[0] || !values[2] || !values[3]) {
						throw new Error(`节点表第${i+1}行格式错误：id、content或estimated_time字段不能为空`);
					}
					
					const node: DataNode = {
						id: values[0],
						level: levelValue,
						content: values[2],
						estimated_time: values[3],
						status: 0 // 初始状态为未安排
					};
					nodes.push(node);

				}
			}
		}
		
		// 解析边表
		const edgesTable = tables[1].trim();
		const edgeLines = edgesTable.split('\n');
		const edgeHeaders = edgeLines[0]?.split('\t');
		const edges: DataEdge[] = [];
		
		// 确保有表头和至少一行数据
		if (edgeHeaders && edgeHeaders.length >= 2 && edgeLines.length > 1) {
			for (let i = 1; i < edgeLines.length; i++) {
				const line = edgeLines[i].trim();
				if (line) {
					const values = line.split('\t');
					// 严格检查字段数量，缺少时抛出错误并指明行号
					if (values.length < 2) {
						throw new Error(`边表第${i+1}行格式错误：缺少必要字段，需要至少2个字段（from, to）`);
					}
					
					edges.push({
						from: values[0],
						to: values[1]
					});
				}
			}
		}
		
		return { nodes, edges };
	}

	// 将Data JSON转换为Canvas JSON
	convertDataJsonToCanvasJson(dataJson: DataJson): CanvasJson {
		// 创建节点映射，用于快速查找
		const nodeMap = new Map<string, DataNode>();
		dataJson.nodes.forEach(node => nodeMap.set(node.id, node));
		
		// 计算节点位置和尺寸
		const canvasNodes: CanvasNode[] = this.calculateNodePositionsAndSizes(dataJson.nodes);
		
		// 创建边，只添加有效边（to指向存在的节点）
		const canvasEdges: CanvasEdge[] = [];
		dataJson.edges.forEach(edge => {
			// 验证边的有效性：to节点必须存在于节点映射中
			if (nodeMap.has(edge.to)) {
				canvasEdges.push({
					id: `${edge.from}_${edge.to}`,
					styleAttributes: {},
					toFloating: false,
					fromFloating: false,
					fromNode: edge.from,
					fromSide: 'right',
					toNode: edge.to,
					toSide: 'left'
				});
			}
		});
		
		return {
			nodes: canvasNodes,
			edges: canvasEdges,
			metadata: {
				version: '1.0-1.0',
				frontmatter: {}
			}
		};
	}

	// 计算节点位置和尺寸
	calculateNodePositionsAndSizes(nodes: DataNode[]): CanvasNode[] {
		// 按照level分组
		const nodesByLevel = new Map<number, DataNode[]>();
		nodes.forEach(node => {
			if (!nodesByLevel.has(node.level)) {
				nodesByLevel.set(node.level, []);
			}
			nodesByLevel.get(node.level)!.push(node);
		});
		
		// 计算位置和尺寸
		const canvasNodes: CanvasNode[] = [];
		let currentX = -1500;
		const yPositions: {[key: number]: number} = {};
		
		// 按照level排序
		const sortedLevels = Array.from(nodesByLevel.keys()).sort();
		
		sortedLevels.forEach((level, levelIndex) => {
			const levelNodes = nodesByLevel.get(level)!;
			yPositions[level] = 220 + (levelIndex % 5) * 100; // 不同level使用不同的Y位置
			
			levelNodes.forEach((node, nodeIndex) => {
				// 根据内容长度计算宽度
				const contentLength = node.content.length;
				const width = Math.max(120, Math.min(contentLength * 8, 400));
				const height = 60;
				
				// 设置styleAttributes
				let styleAttributes: {[key: string]: any} = {};
				if (level === 0 || level === 1) {
					styleAttributes = { textAlign: 'center' };
				} else if (level === 3 || level === 4) {
					styleAttributes = {};
				}
				
				canvasNodes.push({
					id: node.id,
					type: 'text',
					text: node.content,
					styleAttributes,
					x: currentX,
					y: yPositions[level],
					width,
					height,
					color: STATUS_TO_COLOR[node.status] || '0'
				});
				
				currentX += width + 40; // 节点间距
			});
		});
		
		return canvasNodes;
	}

	// 同步Data JSON和Canvas JSON
	async syncJsonFiles(dataJsonPath: string, canvasJsonPath: string) {
		// 读取两个JSON文件
		const dataJson = await this.readJsonFile<DataJson>(dataJsonPath);
		const canvasJson = await this.readJsonFile<CanvasJson>(canvasJsonPath);
		
		// 创建节点映射
		const dataNodeMap = new Map<string, DataNode>();
		dataJson.nodes.forEach(node => dataNodeMap.set(node.id, node));
		
		const canvasNodeMap = new Map<string, CanvasNode>();
		canvasJson.nodes.forEach(node => canvasNodeMap.set(node.id, node));
		
		// 检查是否需要更新Canvas JSON
		let needsUpdate = false;
		
		// 更新节点
		canvasJson.nodes.forEach(canvasNode => {
			const dataNode = dataNodeMap.get(canvasNode.id);
			if (dataNode) {
				// 更新文本内容
				if (canvasNode.text !== dataNode.content) {
					canvasNode.text = dataNode.content;
					needsUpdate = true;
				}
				
				// 更新颜色（基于状态）
				const newColor = STATUS_TO_COLOR[dataNode.status] || '0';
				if (canvasNode.color !== newColor) {
					canvasNode.color = newColor;
					needsUpdate = true;
				}
			}
		});
		
		// 检查是否有新节点需要添加
		dataJson.nodes.forEach(dataNode => {
			if (!canvasNodeMap.has(dataNode.id)) {
				// 添加新节点
				const newCanvasNode: CanvasNode = {
					id: dataNode.id,
					type: 'text',
					text: dataNode.content,
					styleAttributes: dataNode.level === 0 || dataNode.level === 1 ? { textAlign: 'center' } : {},
					x: -1500, // 默认位置，可以后续优化
					y: 220,
					width: Math.max(120, Math.min(dataNode.content.length * 8, 400)),
					height: 60,
					color: STATUS_TO_COLOR[dataNode.status] || '0'
				};
				canvasJson.nodes.push(newCanvasNode);
				needsUpdate = true;
			}
		});
		
		// 检查是否有新边需要添加
		const existingEdgeIds = new Set(canvasJson.edges.map(edge => `${edge.fromNode}_${edge.toNode}`));
		dataJson.edges.forEach(edge => {
			// 验证边的有效性：to节点必须存在于数据节点映射中
			if (dataNodeMap.has(edge.to)) {
				const edgeId = `${edge.from}_${edge.to}`;
				if (!existingEdgeIds.has(edgeId)) {
					// 添加新边
					canvasJson.edges.push({
						id: edgeId,
						styleAttributes: {},
						toFloating: false,
						fromFloating: false,
						fromNode: edge.from,
						fromSide: 'right',
						toNode: edge.to,
						toSide: 'left'
					});
					needsUpdate = true;
				}
			}
		});
		
		// 如果需要更新，写入Canvas JSON
		if (needsUpdate) {
			await this.writeJsonFile(canvasJsonPath, canvasJson);
			new Notice(`已同步 ${path.basename(canvasJsonPath)}`);
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
		const {containerEl} = this;

		containerEl.empty();
		containerEl.createEl('h2', { text: 'Node Graph 设置' });

		// TSV文件夹路径设置
		new Setting(containerEl)
			.setName('TSV文件夹路径')
			.setDesc('存放TSV文件的文件夹路径')
			.addText(text => text
				.setPlaceholder('tsv')
				.setValue(this.plugin.settings.tsvFolderPath)
				.onChange(async (value) => {
					this.plugin.settings.tsvFolderPath = value;
					await this.plugin.saveSettings();
				}));

		// Data JSON文件夹路径设置
		new Setting(containerEl)
			.setName('Data JSON文件夹路径')
			.setDesc('存放Data JSON文件的文件夹路径')
			.addText(text => text
				.setPlaceholder('data_json')
				.setValue(this.plugin.settings.dataJsonFolderPath)
				.onChange(async (value) => {
					this.plugin.settings.dataJsonFolderPath = value;
					await this.plugin.saveSettings();
				}));

		// Canvas JSON文件夹路径设置
		new Setting(containerEl)
			.setName('Canvas JSON文件夹路径')
			.setDesc('存放Canvas JSON文件的文件夹路径')
			.addText(text => text
				.setPlaceholder('canvas_json')
				.setValue(this.plugin.settings.canvasJsonFolderPath)
				.onChange(async (value) => {
					this.plugin.settings.canvasJsonFolderPath = value;
					await this.plugin.saveSettings();
				}));
	}
}
