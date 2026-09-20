# 知识图谱常用查询（可直接复制执行）

> 从 `AGENTS.md` 的「知识图谱」一节抽出（AGENTS.md 有工作区指令体积预算，这些命令是**操作细节**、
> 复制一次就完事，长期占主指令体积不划算）。命令均在仓库根目录运行，已实测可用。
>
> 何时需要读：要做**跨文件改动**、想知道"谁调用了这个函数 / 这个文件属于哪一层 / 哪些测试覆盖了它"
> 时。图谱的时效性与重建见 `docs/research/10-knowledge-graph-rebuild.md`。
> **注意**：图谱锚点落后 HEAD 时，锚点之后新增/删除的文件与符号不可信（改行不影响结论）。

### 常用查询（可直接复制执行）

（命令均在仓库根目录运行，已实测可用。）
**① 某文件属于哪个层？摘要、标签与它包含的符号？**

```bash
node -e "const g=require('./.understand-anything/knowledge-graph.json');const id='file:lib/routes.js';console.log(g.layers.filter(l=>l.nodeIds.includes(id)).map(l=>l.id+' '+l.name).join('\n'));console.log(JSON.stringify(g.nodes.find(n=>n.id===id),null,1));console.log(g.edges.filter(e=>e.type==='contains'&&e.source===id).map(e=>e.target).join('\n'))"
```

**② 谁调用了某个函数（入边追踪，找调用方）/ 它又调用了谁（出边）？**

```bash
node -e "
const g=require('./.understand-anything/knowledge-graph.json');
const id='function:lib/store.js:getSettings';   // ← 改成目标节点 id
const inb=g.edges.filter(e=>e.target===id), out=g.edges.filter(e=>e.source===id);
console.log('← 调用方:', inb.map(e=>e.type+' '+e.source));
console.log('→ 依赖面:', out.map(e=>e.type+' '+e.target));
"
```

**③ 改动影响面：从某节点出发，反向传递闭包（谁会间接受影响）**

```bash
node -e "
const g=require('./.understand-anything/knowledge-graph.json');
const seed='file:lib/store.js';                    // ← 改成你将修改的文件
const rel=new Set(['imports','calls','depends_on','contains','tested_by']);
const rev={};for(const e of g.edges)if(rel.has(e.type))(rev[e.target]=rev[e.target]||[]).push(e.source);
const seen=new Set([seed]);let q=[seed];
while(q.length){const cur=q.pop();for(const p of rev[cur]||[])if(!seen.has(p)){seen.add(p);q.push(p);}}
console.log([...seen].filter(x=>x!==seed).join('\n'));
"
```

**④ 哪些测试覆盖了哪些文件？**

```bash
node -e "const g=require('./.understand-anything/knowledge-graph.json');console.log(g.edges.filter(e=>e.type==='tested_by').map(e=>e.source+' → '+e.target).join('\n'))"
```

**⑤ 按关键词搜索语义（在中文摘要与标签里找）**

```bash
node -e "
const g=require('./.understand-anything/knowledge-graph.json');const kw='SSE';   // ← 关键词
console.log(g.nodes.filter(n=>(n.summary||'').includes(kw)||(n.tags||[]).some(t=>t.toLowerCase().includes(kw.toLowerCase()))).map(n=>n.id+' :: '+(n.summary||'').slice(0,60)).join('\n---\n'));
"
```

**⑥ 走 15 步导览**：读 `g.tour`（按 `order` 排序，含每步 `nodeIds` 与 `languageLesson`）。
