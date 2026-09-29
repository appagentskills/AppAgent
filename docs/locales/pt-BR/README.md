# AppAgent

**Crie e mantenha apps do ServiceNow com um agente. Como uma extensão do Chrome.**

O AppAgent é o seu parceiro de desenvolvimento para o ServiceNow. Ele cria e mantém apps e executa testes para eles. Os testes são feitos preenchendo formulários e tirando capturas de tela. Não é preciso ter conhecimento técnico.

Você usa a sua própria chave de API (BYOK) e pronto! Ele é compatível com OpenAI, OpenRouter, Claude API e até com os planos do Claude Code (fale conosco em particular).

É uma extensão do Chrome que armazena todo o chat no seu navegador (os dados nem saem do seu navegador). Ela só interage com a sua instância do ServiceNow e com o provedor de API do seu modelo.

![Exemplo do AppAgent](AppAgentExample.png)

Ele usa menos tokens que o Claude Code, pois se apoia bastante no cache da API, no cache de ferramentas e no encadeamento de ferramentas (tudo pronto para uso).

Você pode adicionar habilidades a ele, ele controla o navegador por meio de abas e tem botões de desfazer mecânicos para todas as alterações que faz na sua instância.

> **Observação:** por enquanto, o AppAgent deve ser usado apenas em instâncias de desenvolvimento.

## Fale conosco

Preencha este formulário e entraremos em contato: [Formulário de contato](https://forms.gle/wP7CZjRJDMgQnGV9A)

## Recursos

| Recurso | O que faz |
|---------|--------------|
| **Use o seu próprio modelo** | Escolha entre Claude, GPT, Gemini, Grok e outros |
| **Entrar com o Claude** | Fluxo OAuth — use o seu plano Claude Code Personal ou Enterprise, sem precisar de chave de API |
| **Imagens e PDFs** | Anexe capturas de tela, diagramas ou documentos para o agente analisar |
| **Edição de código** | Lê e modifica scripts com controle completo de versões |
| **Controle do navegador** | Testa o próprio trabalho: navega pelas abas, clica, preenche formulários e tira capturas de tela |
| **Dashboards ao vivo** | Cria widgets que buscam dados em tempo real da sua instância |
| **Habilidades do agente** | Crie suas próprias habilidades para ampliar as capacidades do agente |
| **Ações de habilidades** | As habilidades podem exibir botões de um clique na página inicial que disparam fluxos de trabalho predefinidos |
| **Progresso ao vivo** | Veja o que o agente está fazendo em tempo real — indicadores de progresso que mudam entre os estados em execução/travado/concluído/erro |
| **Espaços de trabalho** | Área de arquivos por chat — clone repositórios do GitHub, leia, escreva, edite, compare e troque de branch. Vários repositórios por chat, com proteção de propriedade entre chats |
| **Git e push para o GitHub integrados** | O agente pode fazer pull e push no GitHub, criar branches e abrir pull requests direto do chat — sem terminal, sem IDE |
| **Documentos inteligentes** | Markdown persistente e versionado que o agente pode editar e referenciar em diferentes chats |
| **Várias instâncias** | Detecta automaticamente todas as instâncias do ServiceNow abertas no seu navegador; o agente pode ver e atuar em todas elas a partir de um único chat |
| **Subagentes** | Delega trabalhos pesados ou paralelos a agentes workers em segundo plano, que enviam o resultado ao chat principal |
| **25 idiomas** | Interface e ajuda em inglês e em mais 24 idiomas, incluindo árabe e hebraico, da direita para a esquerda |
| **Pausar e interromper** | Pause ou envie uma nova mensagem durante o streaming — a chamada em andamento é cancelada imediatamente |
| **Pesquisa na web** | Buscas na web gratuitas e sem chave via Google e DuckDuckGo |
| **Desfazer mecânico** | Todas as alterações registradas, reversão com um clique |
| **Exportar para XML** | Exporte todas as alterações para implantá-las em outras instâncias |
| **Permissões de ferramentas** | Segurança integrada: controle o que o agente pode fazer na instância |
| **Padrões abertos** | Compatível com [OpenRouter](https://openrouter.ai) e [AgentSkills.io](https://agentskills.io) |
| **Cache do modelo** | Reduz o custo em até 10x com o cache de prompts |
| **Contexto inteligente** | Carrega apenas as partes necessárias de arquivos grandes. Não sobrecarrega o modelo |
| **Zero dependências** | Sem bibliotecas, sem frameworks, JS puro |

## Como funciona

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│              │      │              │      │              │
│   Chrome     │◀────▶│    Model     │      │  ServiceNow  │
│  Extension   │      │   (Claude,   │      │   Instance   │
│              │      │   GPT, etc)  │      │              │
│  [AppAgent]  │      └──────────────┘      │              │
│              │◀──────────────────────────▶│              │
└──────────────┘                            └──────────────┘
```

O AppAgent é uma extensão do Chrome com um loop de agente integrado. Você descreve o que quer → o agente consulta o modelo → executa ferramentas no navegador → acessa o ServiceNow com as permissões do seu usuário atual. O agente se comunica diretamente com os provedores de API dos modelos, sejam locais (on-premises) ou online.

## Comparação do AppAgent

| | AppAgent | Claude Code | Cursor | Base44 |
|---|---|---|---|---|
| **Usuário-alvo** | Não técnico | Desenvolvedores | Desenvolvedores | Fundadores não técnicos |
| **Feito para o ServiceNow** | ✓ | ✗ | ✗ | ✗ |
| **Ações agênticas no ServiceNow** | ✓ | ✓ | ✗ | ✗ |
| **Exige ambiente de desenvolvimento** | ✗ | ✓ | ✓ | ✗ |
| **Cria apps** | ✓ | ✓ | ✓ | ✓ |
| **Controle do navegador para testes** | ✓ | ✗ | ✗ | ✗ |
| **Tira capturas de tela** | ✓ | ✗ | ✗ | ✗ |
| **Tarefas em segundo plano** | ✓ (via ações de habilidades) | ✗ | ✓ | ✗ |
| **Agentes em paralelo** | ✓ (subagentes) | ✗ | ✓ | ✗ |
| **Desfazer mecânico** | ✓ | ✗ | ✗ | ✗ |
| **Imagens e PDFs** | ✓ | ✓ | ✓ | Limitado |
| **Dashboards inteligentes** | ✓ | ✗ | ✗ | ✓ |
| **Habilidades extensíveis** | ✓ | ✓ | ✗ | ✗ |
| **Ações de habilidades (botões de um clique)** | ✓ | ✗ | ✗ | ✗ |
| **Indicadores de progresso ao vivo** | ✓ | ✗ | ✗ | ✗ |
| **Suporte a várias instâncias** | ✓ | ✗ | ✗ | ✗ |
| **Espaços de trabalho por chat** | ✓ | ✗ | ✗ | ✗ |
| **Git integrado** | ✓ | ✓ (CLI) | ✓ (IDE) | ✗ |
| **Push para o GitHub pelo chat** | ✓ | ✓ (CLI) | Limitado | ✗ |
| **Documentos inteligentes** | ✓ | ✗ | ✗ | ✗ |
| **Pausar / interromper durante o streaming** | ✓ | ✓ | Limitado | ✗ |
| **Pesquisa na web** | ✓ | ✓ | ✓ | ✗ |
| **Permissões de ferramentas** | ✓ | ✓ | Limitado | ✗ |
| **Exportar alterações** | ✓ XML | ✓ | ✓ | ✓ |
| **Use o seu próprio modelo** | ✓ | ✗ | ✓ | ✗ |
| **Cache de prompts** | ✓ | ✓ | ✓ | ✗ |
| **Contexto inteligente** | ✓ | ✓ | ✓ | ✗ |
| **Zero dependências** | ✓ | ✗ | ✗ | ✓ |

*O Base44 não cria apps do ServiceNow, mas foi incluído para quem já conhece a experiência dele.*

## Configuração

1. **Instalar** — Instale a extensão AppAgent pela Chrome Web Store (ou carregue a versão descompactada para desenvolvimento)
2. **Obter uma chave de API** — Cadastre-se no [OpenRouter](https://openrouter.ai), use a Anthropic/OpenAI diretamente ou conecte a sua assinatura do Claude Code (Enterprise ou Personal)
3. **Configurar** — Abra a extensão e adicione a sua chave de API (ou entre com o Claude) em Configurações → Provedores de API
4. **Começar a criar** — Abra a sua instância do ServiceNow em uma aba (ela é detectada automaticamente) e comece a conversar

## Exemplos

### "Crie um app simples para acompanhar as tarefas da equipe"
O AppAgent cria a tabela, adiciona os campos, monta o layout de formulário e de lista e configura um módulo no navegador de aplicativos. Um prompt, um app completo.

### "Faça uma auditoria completa nesta instância"
O AppAgent procura brechas de segurança, contas de administrador inativas, registros obsoletos e verifica as boas práticas de configuração; depois, entrega um relatório com recomendações.

### "Teste esta página e relate os problemas que encontrar"
O AppAgent abre a página em uma aba do navegador, preenche formulários, clica em botões, tira capturas de tela e reúne em um relatório tudo o que encontrar.

### "Tem um bug neste formulário, você consegue corrigir?"
O AppAgent abre o formulário, inspeciona os scripts por trás dele, identifica o bug, corrige o código e mostra exatamente o que mudou. Um clique para desfazer, se necessário.

### "Crie um widget de dashboard para os meus chamados abertos"
O AppAgent cria um widget ao vivo que busca dados em tempo real da sua instância e os exibe no seu dashboard.

### "Importe este arquivo Excel para a tabela de usuários"
O AppAgent lê o arquivo, associa as colunas aos campos e importa os dados para a sua instância.

### "Verifique o histórico de upgrade e corrija os problemas de customização"
O AppAgent analisa o que mudou no upgrade, encontra as customizações quebradas e as corrige.

### "Avise a equipe quando um incidente P1 for criado"
O AppAgent cria uma regra de notificação que é disparada em incidentes P1 e envia um alerta para a sua equipe.

---

## A visão

Hoje o Opus 4.7 é ótimo, mas ainda precisa de um pouco de supervisão.

Vamos continuar levando ao limite o que os modelos de IA conseguem fazer a cada geração e seguir subindo na pilha de abstração, até travarmos.

GPT-4 => Autocompletar código
GPT-4o => Escreve um arquivo independente
Sonnet 3.5 => Edita um arquivo em uma base de código
Opus 4.5 => Escreve um recurso completo
Opus 4.6 => Mantém um app de ponta a ponta
Opus 4.7 => ... (ainda estamos testando)

---

## Roadmap

- RAG
- Especificações e casos de teste

Sem ordem específica.

Esta versão serve principalmente para coletar feedback.

As próximas versões talvez não sejam open source, mas vamos continuar mantendo esta versão até que ela esteja estável.

---

## Diretrizes de contribuição

Por favor, não abra PRs: este é um projeto comercial, e só abrimos o código para dar visibilidade e transmitir confiança.

Se encontrar bugs, você pode abrir uma issue ou falar diretamente conosco. Oferecemos apenas suporte comercial, então só vamos corrigir bugs que possam afetar outros usuários.

---

## Licença

Uso privado e comercial. Modificação interna permitida. Distribuição e revenda proibidas.
