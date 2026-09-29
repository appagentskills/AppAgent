# AppAgent

**Crie e mantenha aplicações ServiceNow com um agente. Numa extensão do Chrome.**

O AppAgent é o seu parceiro de desenvolvimento para o ServiceNow. Consegue criar e manter aplicações e executar testes sobre elas. Faz os testes a preencher formulários e a tirar capturas de ecrã. Não são necessários conhecimentos técnicos.

Basta trazer a sua própria chave de API (BYOK) e está pronto! É compatível com OpenAI, OpenRouter, Claude API e até com os planos do Claude Code (contacte-nos em privado).

É uma extensão do Chrome que guarda toda a conversa no seu navegador (nada sai sequer do seu navegador). Só interage com a sua instância do ServiceNow e com o fornecedor da API do seu modelo.

![Exemplo do AppAgent](AppAgentExample.png)

Utiliza menos tokens do que o Claude Code, porque tira grande partido da cache da API, da cache de ferramentas e do encadeamento de ferramentas (de origem).

Pode adicionar-lhe competências, tem controlo do navegador através de separadores e tem botões de anulação mecânica para todas as alterações que faz na sua instância.

> **Nota:** por agora, o AppAgent destina-se a ser utilizado apenas em instâncias de desenvolvimento.

## Contacte-nos

Preencha este formulário e entraremos em contacto: [Formulário de contacto](https://forms.gle/wP7CZjRJDMgQnGV9A)

## Funcionalidades

| Funcionalidade | O que faz |
|---------|--------------|
| **Traga o seu próprio modelo** | Escolha entre Claude, GPT, Gemini, Grok e outros |
| **Iniciar sessão com o Claude** | Fluxo OAuth — utilize o seu plano Claude Code Personal ou Enterprise existente, sem precisar de chave de API |
| **Imagens e PDFs** | Anexe capturas de ecrã, diagramas ou documentos para o agente analisar |
| **Edição de código** | Lê e modifica scripts com controlo total de versões |
| **Controlo do navegador** | Testa o seu próprio trabalho: navega em separadores, clica, preenche formulários, tira capturas de ecrã |
| **Painéis em tempo real** | Cria widgets que obtêm dados em tempo real da sua instância |
| **Competências do agente** | Crie as suas próprias competências para alargar as capacidades do agente |
| **Ações de competências** | As competências podem disponibilizar botões de um clique na página inicial que iniciam fluxos de trabalho predefinidos |
| **Progresso em tempo real** | Veja o que o agente está a fazer em tempo real — indicadores de progresso dinâmicos com os estados em execução/bloqueado/concluído/erro |
| **Espaços de trabalho** | Área de ficheiros por conversa — clone repositórios GitHub, leia, escreva, edite, compare e mude de ramo. Vários repositórios por conversa, com proteção da propriedade entre conversas |
| **Git integrado e envio para o GitHub** | O agente pode fazer pull / push no GitHub, criar ramos e abrir pull requests diretamente a partir da conversa — sem terminal, sem IDE |
| **Documentos inteligentes** | Markdown persistente e com controlo de versões que o agente pode editar e referenciar entre conversas |
| **Várias instâncias** | Deteta automaticamente todas as instâncias do ServiceNow abertas no seu navegador; o agente pode vê-las e agir em todas a partir de uma única conversa |
| **Subagentes** | Delega trabalho pesado ou em paralelo em agentes trabalhadores em segundo plano, que comunicam os resultados à conversa principal |
| **25 idiomas** | Interface e ajuda em inglês e em mais 24 idiomas, incluindo árabe e hebraico, da direita para a esquerda |
| **Pausar e interromper** | Pause ou envie uma nova mensagem a meio da resposta — a chamada em curso é cancelada de imediato |
| **Pesquisa na web** | Pesquisas na web gratuitas e sem chave através do Google e do DuckDuckGo |
| **Anulação mecânica** | Todas as alterações registadas, reversão com um clique |
| **Exportação para XML** | Exporte todas as alterações para implementação noutras instâncias |
| **Permissões das ferramentas** | Segurança integrada: controle o que o agente pode fazer na instância |
| **Normas abertas** | Compatível com [OpenRouter](https://openrouter.ai) e [AgentSkills.io](https://agentskills.io) |
| **Cache do modelo** | Reduz o custo até 10 vezes graças à cache de prompts |
| **Contexto inteligente** | Carrega apenas as partes necessárias dos ficheiros grandes. Não sobrecarrega o modelo |
| **Zero dependências** | Sem bibliotecas, sem frameworks, JS vanilla puro |

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

O AppAgent é uma extensão do Chrome com um ciclo de agente integrado. Descreve o que pretende → O agente consulta o modelo → Executa ferramentas no navegador → Acede ao ServiceNow com as permissões do seu utilizador atual. O agente comunica diretamente com os fornecedores de API dos modelos, locais ou online.

## Como o AppAgent se compara

| | AppAgent | Claude Code | Cursor | Base44 |
|---|---|---|---|---|
| **Utilizador-alvo** | Não técnico | Programadores | Programadores | Fundadores não técnicos |
| **Criado para o ServiceNow** | ✓ | ✗ | ✗ | ✗ |
| **Ações agênticas no ServiceNow** | ✓ | ✓ | ✗ | ✗ |
| **Requer ambiente de desenvolvimento** | ✗ | ✓ | ✓ | ✗ |
| **Cria aplicações** | ✓ | ✓ | ✓ | ✓ |
| **Controlo do navegador para testes** | ✓ | ✗ | ✗ | ✗ |
| **Tira capturas de ecrã** | ✓ | ✗ | ✗ | ✗ |
| **Tarefas em segundo plano** | ✓ (através das Ações de competências) | ✗ | ✓ | ✗ |
| **Agentes em paralelo** | ✓ (Subagentes) | ✗ | ✓ | ✗ |
| **Anulação mecânica** | ✓ | ✗ | ✗ | ✗ |
| **Imagens e PDFs** | ✓ | ✓ | ✓ | Limitado |
| **Painéis inteligentes** | ✓ | ✗ | ✗ | ✓ |
| **Competências extensíveis** | ✓ | ✓ | ✗ | ✗ |
| **Ações de competências (botões de um clique)** | ✓ | ✗ | ✗ | ✗ |
| **Indicadores de progresso em tempo real** | ✓ | ✗ | ✗ | ✗ |
| **Suporte para várias instâncias** | ✓ | ✗ | ✗ | ✗ |
| **Espaços de trabalho por conversa** | ✓ | ✗ | ✗ | ✗ |
| **Git integrado** | ✓ | ✓ (CLI) | ✓ (IDE) | ✗ |
| **Envio para o GitHub a partir da conversa** | ✓ | ✓ (CLI) | Limitado | ✗ |
| **Documentos inteligentes** | ✓ | ✗ | ✗ | ✗ |
| **Pausar / interromper a meio da resposta** | ✓ | ✓ | Limitado | ✗ |
| **Pesquisa na web** | ✓ | ✓ | ✓ | ✗ |
| **Permissões das ferramentas** | ✓ | ✓ | Limitado | ✗ |
| **Exportar alterações** | ✓ XML | ✓ | ✓ | ✓ |
| **Traga o seu próprio modelo** | ✓ | ✗ | ✓ | ✗ |
| **Cache de prompts** | ✓ | ✓ | ✓ | ✗ |
| **Contexto inteligente** | ✓ | ✓ | ✓ | ✗ |
| **Zero dependências** | ✓ | ✗ | ✗ | ✓ |

*O Base44 não consegue criar aplicações ServiceNow, mas foi incluído para os utilizadores que já conhecem a sua experiência.*

## Configuração

1. **Instalar** — Instale a extensão AppAgent a partir da Chrome Web Store (ou carregue-a descompactada para desenvolvimento)
2. **Obter uma chave de API** — Registe-se em [OpenRouter](https://openrouter.ai), utilize diretamente a Anthropic/OpenAI ou ligue a sua subscrição do Claude Code (Enterprise ou Personal)
3. **Configurar** — Abra a extensão e adicione a sua chave de API (ou inicie sessão com o Claude) em Definições → Fornecedores de API
4. **Começar a criar** — Abra a sua instância do ServiceNow num separador (é detetada automaticamente) e comece a conversar

## Exemplos

### "Cria-me uma aplicação simples para acompanhar as tarefas da equipa"
O AppAgent cria a tabela, adiciona os campos, constrói um formulário e o esquema da lista e configura um módulo no navegador de aplicações. Um prompt, uma aplicação completa.

### "Faz uma auditoria completa a esta instância"
O AppAgent procura falhas de segurança, contas de administrador inativas, registos obsoletos e boas práticas de configuração e, em seguida, entrega-lhe um relatório com recomendações.

### "Testa esta página e comunica os problemas que encontrares"
O AppAgent abre a página num separador do navegador, preenche formulários, clica em botões, tira capturas de ecrã e compila um relatório com tudo o que encontrar.

### "Há um erro neste formulário, consegues corrigi-lo?"
O AppAgent abre o formulário, inspeciona os scripts por trás dele, identifica o erro, corrige o código e mostra-lhe exatamente o que mudou. Um clique para anular, se necessário.

### "Cria um widget no painel para os meus pedidos em aberto"
O AppAgent cria um widget em tempo real que obtém dados atualizados da sua instância e os apresenta no seu painel.

### "Importa este ficheiro Excel para a tabela de utilizadores"
O AppAgent lê o ficheiro, associa as colunas aos campos e importa os dados para a sua instância.

### "Verifica o histórico de atualizações e corrige os problemas de personalização"
O AppAgent analisa o que mudou na atualização, encontra as personalizações danificadas e corrige-as.

### "Notifica a equipa quando for criado um incidente P1"
O AppAgent cria uma regra de notificação que é acionada nos incidentes P1 e envia um alerta à sua equipa.

---

## A visão

Neste momento, o Opus 4.7 é excelente, mas ainda precisa de alguma supervisão.

Vamos continuar a levar ao limite aquilo de que os modelos de IA são capazes em cada geração e a subir na pilha de abstração, até ficarmos bloqueados.

GPT-4 => Conclusão de código
GPT-4o => Escreve um ficheiro autónomo
Sonnet 3.5 => Edita um ficheiro numa base de código
Opus 4.5 => Escreve uma funcionalidade completa
Opus 4.6 => Mantém uma aplicação de ponta a ponta
Opus 4.7 => ... (ainda estamos a testar)

---

## Roteiro

- RAG
- Especificações e casos de teste

Sem nenhuma ordem específica.

Esta versão destina-se sobretudo a recolher feedback.

As próximas versões poderão não ser open source, mas vamos continuar a manter esta versão até que esteja estável.

---

## Diretrizes de contribuição

Não abra PRs: este é um projeto comercial e só disponibilizamos o código em open source por questões de visibilidade e confiança.

Se encontrar erros, pode abrir uma issue ou contactar-nos diretamente. Só oferecemos suporte comercial, pelo que só vamos corrigir os erros que possam afetar outros utilizadores.

---

## Licença

Utilização privada e comercial. Modificação interna permitida. Distribuição e revenda proibidas.
