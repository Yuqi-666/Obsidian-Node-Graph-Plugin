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

interface LinkedListNode {
  data: DataNode;
  predecessors: string[]; // 存储前驱节点的id
  successors: string[];    // 存储后继节点的id
  size: [number,number]; // 节点宽度和高度
}

interface LinkedListGraph {
  nodes: Map<string, LinkedListNode>; // 使用Map方便通过id查找节点
}

interface SubgraphSize {
  	parentID: string;
  	width: number;
  	height: number;
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
		const taskDefault_gap = 100;
		
		const HORIZONTAL_GAP = 100; // 节点之间的水平间距
		const VERTICAL_GAP = 50;    // 节点之间的垂直间距
		const START_X = 0;
		const START_Y = 0;
/**
 * 计算字符串中汉字、字母/数字和其他字符的数量。
 * @param text 要分析的字符串。
 * @returns 包含汉字、字母/数字和其他字符数量的对象。
 */
function countCharacters(text: string): { chinese: number, alphanumeric: number, other: number } {
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
	graphUtils: GraphUtils;
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
					const dataJson = this.graphUtils.convertTsvToDataJson(tsvContent);
					await this.writeJsonFile(dataJsonPath, dataJson);
					new Notice(`已将 ${fileName}.tsv 转换为 Data JSON`);
				}
				
				// 读取Data JSON
				const dataJson = await this.readJsonFile<DataJson>(dataJsonPath);
				
				// 检查是否需要从Data JSON转换到Canvas JSON
				const canvasJsonExists = await this.fileExists(canvasJsonPath);
				if (!canvasJsonExists) {
					// 从Data JSON转换到Canvas JSON
					const canvasJson = this.graphUtils.convertDataJsonToCanvasJson(dataJson);
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

class GraphUtils {
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
	graph: LinkedListGraph = {
		nodes: new Map(),
	};
	// 将Data JSON转换为Canvas JSON
	convertDataJsonToCanvasJson(dataJson: DataJson): CanvasJson {
		const canvasNodes: CanvasNode[] = [];
		const canvasEdges: CanvasEdge[] = [];

		// 将DataJson转换为LinkedListGraph以便进行层级遍历
		this.graph = this.convertDataJsonToLinkedListGraph(dataJson);
		// 预计算并缓存所有节点的宽高，便于后续布局与渲染使用
		this.calculateAllNodeSizes();
		

		

		const levelYOffsets = new Map<number, number>(); // 记录每个层级的Y偏移量
		const levelNodeCounts = new Map<number, number>(); // 记录每个层级已处理的节点数量

		//找到level=0的节点
		const rootNodes: LinkedListNode[] = [];
		this.graph.nodes.forEach((node, id) => {
			if (node.data.level === 0) {
				rootNodes.push(node);
			}
		});
		//遍历rootNodes，将它们添加到canvasNodes中
		rootNodes.forEach(rootNode => {
			canvasNodes.push({
				id: rootNode.data.id,
				type: 'node',
				text: (rootNode.data.level > 0 && rootNode.data.level <= 3) ? '#'.repeat(rootNode.data.level) + ' ' + rootNode.data.content : rootNode.data.content,
				styleAttributes: {"textAlign": "center"},
				x: START_X,
				y: START_Y,
				// 优先使用预计算的尺寸，缺失时退回到即时计算
				width: this.graph.nodes.get(rootNode.data.id)?.size[0] ?? this.calculateNodeWidth(rootNode.data),
				height: NODE_HEIGHT,
				color: '0'
			});
		});

		// 创建边
		dataJson.edges.forEach(edge => {
			// 确保fromNode和toNode都存在于canvasNodes中
			const fromNodeExists = canvasNodes.some(n => n.id === edge.from);
			const toNodeExists = canvasNodes.some(n => n.id === edge.to);

			if (fromNodeExists && toNodeExists) {
				canvasEdges.push({
					id: `${edge.from}-${edge.to}`,
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

	calculateSubGraphSize(node:LinkedListNode): [number,number]{
		if(node.data.level === 1){
			let subgraphSize:SubgraphSize[] = []
			let queue:(LinkedListNode | undefined)[]= [];
			for(const predecessor of node.predecessors){
				let tempNode = this.graph.nodes.get(predecessor);
				if(tempNode?.data.level==node.data.level-1){
					queue.push(tempNode);
				}else{continue;}
			}
			while(queue.length>0){
				let tempNode = queue.shift();
				if (!tempNode) continue;
				for(const predecessor of tempNode.predecessors){
					if(tempNode?.data.level==node.data.level-1){
						queue.push(this.graph.nodes.get(predecessor));
					}else{continue;}
				}
				let [width,height] = this.calculateSubGraphSize(tempNode);
				subgraphSize.push({
					parentID: tempNode.data.id,
					width: width,
					height: height,
				});
			}
			let width = 0;
			let height = 0;
			for(const subgraph of subgraphSize){
				width += subgraph.width;
				width += KRSubgraphs_Gap;
			}
			height = Math.max(...subgraphSize.map(subgraph => subgraph.height))+NODE_HEIGHT+Subgraph_KR_Gap;
			return [width,height];
		}
		else if(node.data.level === 2){
			let subgraphSize:SubgraphSize[] = []
			let queue:(LinkedListNode | undefined)[]= [];
			for(const predecessor of node.predecessors){
				let tempNode = this.graph.nodes.get(predecessor);
				if(tempNode?.data.level==node.data.level-1){
					queue.push(tempNode);
				}else{continue;}
			}
			let task_gap:number[] = [taskDefault_gap];
			let subtask_task_width_left:number[] = [];
			let subtask_task_width_right:number[] = [];

			let width = 0;
			let height = 0;
			while(queue.length>0){
				let tempNode = queue.shift();
				if (!tempNode) continue;
				for(const predecessor of tempNode.predecessors){
					if(tempNode?.data.level==node.data.level-1){
						queue.push(this.graph.nodes.get(predecessor));
					}else{continue;}
				}
				if(subgraphSize.length>0){
					if(subgraphSize.length%2===0)
					{
						const lastParent = this.graph.nodes.get(subgraphSize[subgraphSize.length-1].parentID);
						const secondLastParent = this.graph.nodes.get(subgraphSize[subgraphSize.length-2].parentID);
						if (lastParent && secondLastParent) {
							subtask_task_width_right.push(Subgraph_Task_Gap + Math.max(lastParent.size[1], secondLastParent.size[1]) / 2);
						}
					}else{
						const lastParent = this.graph.nodes.get(subgraphSize[subgraphSize.length - 1].parentID);
						const secondLastParent = this.graph.nodes.get(subgraphSize[subgraphSize.length - 2].parentID);
						if (lastParent && secondLastParent) {
							subtask_task_width_left.push(
								subgraphSize[subgraphSize.length - 1].width +
								Subgraph_Task_Gap +
								Math.max(lastParent.size[1], secondLastParent.size[1]) / 2
							);
						}
					}

				}
				let [subwidth,subheight] = this.calculateSubGraphSize(tempNode);
				
				subgraphSize.push({
					parentID: tempNode.data.id,
					width: subwidth,
					height: subheight,
				});
				let tempgap:number = subheight+TaskSubgraphs_Gap-task_gap[task_gap.length-1];
				task_gap.push(tempgap);
				if(queue.length===0){
					for(let i=0;i<task_gap.length-2;i++)
					{
						height += task_gap[i];
					}
					height += subheight;
					if(subgraphSize.length%2===0){
						const lastParent = this.graph.nodes.get(subgraphSize[subgraphSize.length - 1].parentID);
						if (lastParent) {
							subtask_task_width_right.push(Subgraph_Task_Gap + lastParent.size[1] / 2);
						}
					}else{
						const lastParent = this.graph.nodes.get(subgraphSize[subgraphSize.length - 1].parentID);
						if (lastParent) {
							subtask_task_width_left.push(subgraphSize[subgraphSize.length - 1].width + Subgraph_Task_Gap + lastParent.size[1] / 2);
						}
						
					}
				}

			}
			width = Math.max(...subtask_task_width_left)+Math.max(...subtask_task_width_right);	
			return [width,height];
			//l1+l2 = sh1+c l2+l3 = sh2+c l1+l2+l3+sh4 = height c=TaskSubgraphs_Gap l1 = taskDefault_gap
			

		}
		else if(node.data.level === 1){
			let subgraphSize:SubgraphSize[] = []
			let queue:(LinkedListNode | undefined)[]= [];
			for(const predecessor of node.predecessors){
				let tempNode = this.graph.nodes.get(predecessor);
				if(tempNode?.data.level==node.data.level-1){
					queue.push(tempNode);
				}else{continue;}
			}
			let widths:number[] = [];
			while(queue.length>0){
				let tempNode = queue.shift();
				if (!tempNode) continue;
				for(const predecessor of tempNode.predecessors){
					if(tempNode?.data.level==node.data.level-1){
						queue.push(this.graph.nodes.get(predecessor));
					}else{continue;}
				}
				const nodeInGraph = this.graph.nodes.get(tempNode.data.id);
				if (nodeInGraph) {
					widths.push(nodeInGraph.size[0]);
				}

				
			}
			let width = 0;
			let height = 0;
			height = NODE_HEIGHT*widths.length;
			width = Math.max(...widths);
			return [width,height];
		}
		else{
			return [0,0];
		}
	}

	/**
	 * 计算节点的宽度。
	 * 根据节点的层级、内容字符数量和预设的字符宽度常量来计算。
	 * @param node DataNode对象。
	 * @returns 计算出的节点宽度。
	 */
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

		const calculatedWidth = (chinese * currentChineseCharWidth) + (alphanumeric * currentAlphanumCharWidth) + TOTAL_HORIZONTAL_MARGIN;
		return Math.max(120, calculatedWidth); // 确保最小宽度
	}

	/**
	 * 将Data JSON转换为LinkedListGraph结构。
	 * @param dataJson 包含节点和边的Data JSON数据。
	 * @returns 转换后的LinkedListGraph。
	 */
	convertDataJsonToLinkedListGraph(dataJson: DataJson): LinkedListGraph {
		
		
		// 创建节点映射
		const nodeMap = new Map<string, LinkedListNode>();
		dataJson.nodes.forEach(node => {
			nodeMap.set(node.id, {
				data: node,
				predecessors: [],
				successors: [],
				size: [0, 0]
			});
		});
		
		// 填充前驱和后继关系
		dataJson.edges.forEach(edge => {
			const fromNode = nodeMap.get(edge.from);
			const toNode = nodeMap.get(edge.to);
			if (fromNode && toNode) {
				fromNode.successors.push(edge.to);
				toNode.predecessors.push(edge.from);
			}
		});
		
		return {
			nodes: nodeMap
		};
	}

	/**
	 * 计算并缓存所有节点的尺寸。
	 * 将每个 `LinkedListNode` 的 `size` 字段设置为 `[width, height]`，
	 * 其中 `width` 通过 `calculateNodeWidth` 计算，`height` 使用全局常量 `NODE_HEIGHT`。
	 * 应在 `this.graph = this.convertDataJsonToLinkedListGraph(dataJson)` 之后调用。
	 */
	calculateAllNodeSizes(): void {
		if (!this.graph || !this.graph.nodes) return;
		this.graph.nodes.forEach((llNode) => {
			const width = this.calculateNodeWidth(llNode.data);
			llNode.size = [width, NODE_HEIGHT];
		});
	}
}
