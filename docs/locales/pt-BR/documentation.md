# Primeiros passos {#getting-started}

O AppAgent é um agente de IA para o ServiceNow que funciona como uma extensão do Chrome. Descreva o que você precisa em linguagem simples, e o agente consulta dados, edita registros, cria apps e widgets, testa páginas no seu navegador e depois apresenta os resultados.

:::tip
**Início rápido:** configure um modelo, abra uma aba na sua instância do ServiceNow, digite um pedido no chat e pressione <kbd>Enter</kbd>.
:::

## Configurar um modelo {#guide-setup}

1. Abra as [Configurações](app:openSettingsPageView) e vá até **Provedores de API**
2. Adicione um provedor (Anthropic, OpenRouter ou uma API personalizada compatível com OpenAI) com sua chave de API — ou ative o **OAuth** em um provedor Anthropic para entrar com sua conta do Claude
3. Escolha o modelo a ser usado em **Modelo do agente**

Sua chave de API fica armazenada apenas no seu navegador. As chamadas de IA vão diretamente do seu navegador para o provedor.

## Conectar suas instâncias {#guide-instances}

O AppAgent **detecta automaticamente todas as instâncias do ServiceNow** abertas no mesmo perfil do Chrome — não há nenhuma string de conexão para informar. Faça login em uma instância em uma aba normal, e o agente poderá trabalhar nela com as funções e os direitos de acesso do seu usuário. Peça *"listar instâncias"* para ver todas as instâncias detectadas, suas funções e o status da conexão.

Cada instância tem um **nível de permissão**, escolhido no menu suspenso da instância:

- **Manual** — Você aprova cada operação de escrita (criação, atualização, exclusão, preenchimento de formulários)
- **Auto** — O agente decide sobre as operações de escrita sem perguntar
- **Dev** — Nenhuma aprovação: todas as chamadas de ferramentas nesta instância são executadas sem perguntar. Use apenas em instâncias de desenvolvimento

As leituras são sempre permitidas. Veja [Permissões de ferramentas](#feature-permissions) para um controle mais refinado.

## Iniciar um chat {#guide-chat}

1. Clique em **Novo chat** na barra lateral [Iniciar novo chat →](app:startNewChat)
2. Digite seu pedido, por exemplo *"Mostre todos os incidentes criados hoje"*
3. Pressione <kbd>Enter</kbd> para enviar
4. Acompanhe o trabalho do agente: cada chamada de ferramenta aparece no chat, e pedidos de aprovação aparecem quando uma etapa precisa do seu OK

Você pode continuar digitando enquanto o agente trabalha: enviar uma nova mensagem interrompe a etapa atual, e **Pausar** interrompe a execução.

## Anexar imagens e arquivos {#guide-images}

1. Clique no botão **Anexar arquivo** na área de entrada para adicionar uma imagem, um PDF, um CSV ou um arquivo de texto
2. Ou cole uma imagem da área de transferência, ou arraste e solte no chat
3. Digite sua pergunta sobre o anexo

:::tip
Anexe capturas de tela de erros, mockups de interface ou dados exportados para que o agente veja exatamente o que você vê.
:::

# Principais recursos {#features}

## Chat {#page-chat}

A tela principal de conversa. [Iniciar novo chat →](app:startNewChat)

- **Área de mensagens** — A conversa, incluindo as chamadas de ferramentas e seus resultados
- **Caixa de entrada** — Digite mensagens, anexe arquivos e envie enquanto o agente trabalha para interrompê-lo
- **Pausar / Continuar / Tentar novamente** — Pare o agente, retome a execução ou tente a última etapa novamente
- **Indicador de contexto** — Mostra o quanto a conversa está cheia; clique nele para resumi-la em um novo chat
- **Cartões de resposta** — Um cartão de **Resumo** e um cartão de **Links** (registros, PRs, documentos) podem aparecer abaixo de uma resposta
- **Cabeçalho do chat** — Renomeie ou fixe o chat, ou abra o AppAgent em uma aba inteira do navegador com **Expandir para página inteira**

## Controle do navegador {#feature-browser}

O agente pode abrir e controlar abas do navegador na sua instância para ver e testar páginas:

- **Navegar, clicar, preencher e selecionar** — Eventos realistas, para que formulários e campos de preenchimento automático se comportem como se você estivesse digitando
- **Aguardar** — Aguarda um elemento, um texto ou uma URL em vez de adivinhar tempos de espera
- **Capturas de tela** — Captura a página, um widget ou um único elemento para verificações visuais
- **Inspecionar** — Lê propriedades de elementos, estilos, erros do console e requisições de rede
- **Personificar** — Testa como outro usuário e depois volta ao seu

## Editar registros e histórico de versões {#feature-history}

Cada alteração que o agente faz na sua instância é registrada na barra lateral do chat:

- **Desfazer** — Reverte uma alteração específica
- **Refazer** — Restaura uma alteração revertida
- **Baixar XML** — Exporta todas as alterações, por exemplo para levá-las a outra instância

## Subagentes {#feature-subagents}

Para trabalhos pesados ou paralelos, o agente pode iniciar **subagentes**: workers em segundo plano que rodam em seu próprio chat e contexto e depois enviam um resultado curto de volta ao chat principal.

- **Níveis de modelo** — Cada subagente roda em um nível **pequeno**, **médio** ou **grande**, ou **igual** para usar o modelo do chat principal. Associe os níveis a modelos em [Configurações](app:openSettingsPageView) → **Níveis de modelo dos subagentes**
- **Faixa de workers** — Os subagentes em execução aparecem como chips ao vivo acima da caixa de entrada do chat; abra um para acompanhar o progresso ou ler a transcrição
- **Pool** — O número de subagentes simultâneos é limitado; os excedentes aguardam em uma fila

## Dashboard e widgets {#page-dashboard}

Um dashboard de widgets interativos gerados pelo agente. [Abrir Dashboard →](app:openDashboardView)

1. Clique em **Adicionar widget**
2. Descreva o que você quer, por exemplo *"Um gráfico com os incidentes abertos por prioridade"*
3. O agente cria o widget; peça alterações ou clique em **Regenerar** a qualquer momento

Os widgets podem buscar dados ao vivo da sua instância, então ficam sempre atualizados. Arraste, redimensione, importe e exporte os widgets (veja [Avançado](#advanced)). Os widgets que o agente mostra dentro de um chat podem ser salvos com **Fixar no Dashboard**.

## Documentos inteligentes {#page-documents}

Os **Documentos inteligentes** são documentos Markdown persistentes e versionados que o agente escreve e atualiza — planos, relatórios, especificações, descobertas. Eles são exibidos dentro do chat, guardam todas as versões e podem ser editados diretamente por você. Abra-os em **Documentos** na barra lateral. [Abrir Documentos →](app:openDocumentsView)

## Habilidades {#page-skills}

As habilidades dão ao agente conhecimento e ferramentas extras. [Abrir Habilidades →](app:openSkillsView)

- **Ativar / Desativar** — Ligue ou desligue habilidades; desative as que você não precisa para manter as respostas focadas
- **Nova habilidade** — Escreva sua própria habilidade em Markdown ou use **Editar com o agente**
- **Importar / Exportar** — Compartilhe habilidades como pastas
- **Ações de habilidades** — Algumas habilidades adicionam botões de um clique na página inicial que iniciam um fluxo de trabalho predefinido

Uma habilidade pode fornecer **conhecimento** (instruções, boas práticas) e **ferramentas personalizadas** (funções JavaScript executadas em um sandbox isolado).

## Espaço de trabalho e GitHub {#feature-workspace}

Cada chat tem um **espaço de trabalho** — uma área de arquivos onde o agente pode ler, escrever, editar e comparar arquivos.

- **GitHub** — Conecte uma conta do GitHub nas [Configurações](app:openSettingsPageView) para clonar repositórios em um espaço de trabalho. O agente pode criar branches, enviar commits e abrir pull requests pelo chat
- **Pull requests** — Os PRs abertos a partir de um chat aparecem na barra lateral do chat, com um botão **Mesclar**
- **Proteção entre chats** — Cada arquivo lembra qual chat o alterou, para que dois chats trabalhando em paralelo não sobrescrevam o trabalho um do outro sem aviso
- **Sincronização automática** — Os espaços de trabalho clonados são sincronizados com o GitHub quando você navega, troca de chat ou volta para a aba

## Barra lateral do chat {#feature-sidebar}

A barra lateral direita reúne tudo o que o chat atual produziu:

- **Pull requests** — Título, branch de destino e um botão **Mesclar**
- **Arquivos do espaço de trabalho** — Abra um arquivo para visualizá-lo, ver o diff ou navegar pelas versões anteriores
- **Histórico de versões** — Alterações na instância com **Desfazer**, **Refazer** e **Baixar XML**
- **Workers** — Subagentes em execução e concluídos, com contadores de chamadas de ferramentas, arquivos editados e PRs abertos

## Ações e progresso ao vivo {#feature-actions}

Tarefas longas mostram o progresso ao vivo em vez de ficarem em silêncio:

- **Cartão de progresso** — Um único cartão com um estado colorido (em execução, travado, concluído, erro) e uma lista de etapas
- **Botões de ação** — Botões de um clique que iniciam fluxos de trabalho de acompanhamento
- **Indicador de execução** — A lista de chats marca os chats em que o agente está trabalhando
- **Notificação "Agente concluiu"** — Se você trocar de aba ou de janela durante uma execução, uma notificação na área de trabalho avisa quando o agente terminar

## Chats ativos e tarefas {#feature-jobs}

O indicador de tarefas no cabeçalho abre uma visão ao vivo dos seus chats e do trabalho em segundo plano:

- **Chats ativos** — Chats em execução e chats com resultados não lidos (mostrados em **negrito**), cada um com um anel de uso do contexto
- **Subagentes** — Listados sob o chat principal; abra um para ler a transcrição
- **Expandir** — Abre a lista em um painel maior, com layout em colunas ou em seções

## Permissões de ferramentas {#feature-permissions}

Além do nível de permissão por instância (**Manual**, **Auto**, **Dev**), cada ferramenta tem sua própria configuração em [Configurações](app:openSettingsPageView) → **Permissões de ferramentas**:

- **Permitir** — A ferramenta sempre é executada sem perguntar
- **Auto** — A ferramenta é executada sem perguntar, a menos que o agente sinalize que uma chamada precisa da sua confirmação
- **Perguntar** — Você recebe um pedido de aprovação antes de cada chamada
- **Desativado** — O agente não pode usar a ferramenta

Algumas ferramentas têm controles mais refinados: a API do ServiceNow por método HTTP (GET, POST, PUT, PATCH, DELETE), o controle do navegador por ação (navegar, clicar, preencher, personificar…) e o gerenciamento de habilidades por ação. As caixas de confirmação têm cores de acordo com o risco: **azul** (rotina), **laranja** (cuidado), **vermelho** (destrutiva).

:::tip
Mantenha DELETE e outras operações destrutivas em **Perguntar** e use **Dev** apenas em instâncias de desenvolvimento.
:::

## Ferramentas do agente {#feature-tools}

As principais ferramentas que o agente usa:

| Ferramenta | O que faz |
|------|--------------|
| **API do ServiceNow** (`servicenow_api`) | Lê, cria, atualiza e exclui registros |
| **Script em segundo plano** (`servicenow_run_script`) | Executa um script no servidor da instância (requer a função admin) |
| **Edição de scripts** (`servicenow_diff_edit`) | Altera scripts com edições precisas de busca e substituição |
| **Controle do navegador** (`iframe_tool`) | Navega, clica, preenche, inspeciona e personifica usuários nas abas do navegador |
| **Código no navegador** (`js_eval`) | Executa JavaScript em um sandbox isolado que pode chamar outras ferramentas |
| **Capturas de tela** (`take_screenshot`) | Captura a página, um widget ou um elemento |
| **Widgets e cartões** (`html_widget`, `display`) | Mostra widgets interativos, tabelas, cartões e linhas do tempo no chat |
| **Documentos inteligentes** (`document`) | Cria e atualiza documentos Markdown persistentes |
| **Perguntar ao usuário** (`prompt_user`) | Pede informações a você com um formulário no chat |
| **Subagentes** (`spawn_sub_agent`) | Delega trabalho a workers em segundo plano |
| **Espaço de trabalho** (`workspace`) | Trabalha com arquivos e repositórios do GitHub |
| **Busca na web** (`web_fetch`) | Lê páginas da web pública |
| **Habilidades** (`get_skill`, `manage_skill`) | Lê e gerencia habilidades |

Abra [Configurações](app:openSettingsPageView) → **Permissões de ferramentas** para ver todas as ferramentas, a origem e a permissão de cada uma.

## Cache de conteúdo grande {#feature-caching}

Quando o resultado de uma ferramenta é grande demais para a conversa (mais de 4K tokens por padrão), o AppAgent o armazena em cache. O agente recebe um resumo da estrutura e depois lê, pesquisa ou navega apenas pelas partes de que precisa. Isso mantém os chats rápidos e focados. Altere o limite (de 1K a 100K tokens) em [Configurações](app:openSettingsPageView) → **Cache de conteúdo grande**.

## Indicador de contexto {#feature-saturation}

O **indicador de contexto** ao lado da caixa de entrada do chat mostra o quanto a conversa está cheia. Acima de 50%, o agente é orientado a finalizar e passar o trabalho pesado restante para subagentes; em 100%, ele para e apresenta um relatório. Clique no indicador a qualquer momento para resumir a conversa em um novo chat.

## Uso e limites de taxa {#feature-usage}

- **Indicador de uso** — O cabeçalho mostra o seu uso da API e os limites restantes; clique nele para ver os detalhes
- **Novas tentativas automáticas** — Quando o provedor está com limite de taxa ou sobrecarregado (HTTP 429 / 529), o AppAgent aguarda, tenta novamente de forma automática e mostra uma contagem regressiva no chat
- **Sem créditos** — Quando um 429 na verdade significa que seus créditos acabaram, o chat informa isso claramente

## Idiomas {#feature-languages}

A interface está disponível em inglês e em mais 24 idiomas: alemão, árabe, chinês (simplificado, tradicional), coreano, dinamarquês, espanhol, finlandês, francês (França, Canadá), hebraico, holandês, húngaro, italiano, japonês, norueguês, polonês, português (Brasil, Portugal), russo, sueco, tailandês, tcheco e turco.

Escolha um em [Configurações](app:openSettingsPageView) → **Idioma** ou no menu de configurações rápidas do cabeçalho. **Auto** segue o idioma do seu navegador e usa o inglês como alternativa. A alteração vale na hora, sem recarregar.

- **Direita para a esquerda** — Árabe e hebraico usam um layout da direita para a esquerda
- **Formatos locais** — Datas, horários e números seguem o seu idioma
- **Respostas do agente** — O agente responde no idioma escolhido, a menos que você escreva em outro. Código e nomes de tabelas e campos continuam inalterados
- **Esta página de ajuda** — Exibida no seu idioma; o changelog continua em inglês

# Páginas e configurações {#pages}

## Configurações {#page-settings}

[Abrir Configurações →](app:openSettingsPageView)

- **Modelo do agente** — O modelo que o agente usa
- **Provedores de API** — Anthropic, OpenRouter ou provedores personalizados, com chave de API ou OAuth
- **Endpoints de LLM** — Pares nomeados de `URL + API key` para qualquer API compatível com OpenAI
- **Níveis de modelo dos subagentes** — Associe os níveis pequeno, médio e grande a modelos, ou use **Igual**
- **Esforço de raciocínio, Máximo de tokens e Orçamento de raciocínio** — Ajuste a profundidade e o tamanho das respostas
- **Janela de contexto** — O tamanho de contexto usado pelo indicador de contexto
- **Exibição** — Estatísticas da API, modo compacto, manter a tela ativa
- **Idioma** — Idioma da interface, ou **Auto**
- **Hooks** — Títulos automáticos de chats, notificações de "Agente concluiu" e outras automações
- **Cache de conteúdo grande** — Quando os resultados grandes são armazenados em cache
- **Permissões de ferramentas** — O que é executado automaticamente, o que pede confirmação antes e o que está desativado
- **GitHub** — Conecte uma conta do GitHub e gerencie os repositórios clonados
- **Prompt do sistema** — Personalize as instruções do agente
- **Gerenciamento de dados** — Exporte, importe ou exclua seus dados

## Histórico {#page-history}

Todas as suas conversas. [Abrir Histórico →](app:openHistoryView)

- **Pesquisar** — Encontre chats por título, conteúdo, ferramentas usadas ou widgets
- **Fixar** — Mantenha os chats importantes no topo
- **Exportar** — Baixe um chat ou todo o seu histórico
- **Estatísticas** — Número de chats, chats fixados e custo total

## Ajuda {#page-docs}

Esta página. [Abrir Ajuda →](app:openDocsView)

- **Pesquisar** — Filtre os tópicos da ajuda pela caixa de pesquisa na barra de ferramentas
- **Conteúdo** — Vá direto para uma seção a partir do sumário
- **Baixar** — Salve a documentação como um arquivo Markdown

# Dicas e atalhos de teclado {#tips}

| Ação | Como |
|--------|-----|
| Enviar mensagem | <kbd>Enter</kbd> |
| Nova linha | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Pesquisar chats | <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> no Mac) |
| Fechar uma caixa de diálogo ou um menu | <kbd>Esc</kbd> |
| Voltar | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Anexar uma imagem | Cole a imagem ou arraste e solte no chat |
| Recomeçar com um resumo | Clique no indicador de contexto |
| Interromper o agente | Envie uma nova mensagem ou clique em **Pausar** |

:::tip
**Seja específico.** Em vez de *"corrija isso"*, diga *"corrija o erro de referência nula na linha 42 do script include MyUtils"*. Sempre que possível, cite a tabela, o registro ou a página.
:::

- **Um objetivo por chat** — Inicie um novo chat para uma tarefa não relacionada; o agente fica mais rápido e mais preciso
- **Deixe o agente testar** — Peça ao agente para abrir a página e verificar a própria alteração com uma captura de tela
- **Use habilidades** — Antes de começar, ative uma habilidade que combine com a sua tarefa (por exemplo, testes ou auditoria)

# Solução de problemas e perguntas frequentes {#faq}

### O agente não vê minha instância

Abra a instância em uma aba do mesmo perfil do Chrome, verifique se você está conectado e depois peça *"listar instâncias"*. Se ela ainda não aparecer, recarregue a aba da instância.

### Recebo um erro de API ou de autenticação

Verifique o seu provedor em [Configurações](app:openSettingsPageView) → **Provedores de API**: a chave de API, o endpoint selecionado e o nome do modelo. No caso do OAuth, entre novamente no claude.ai no mesmo perfil do Chrome.

### O agente diz que atingiu o limite de taxa

O AppAgent tenta novamente de forma automática e mostra uma contagem regressiva. Se isso continuar acontecendo, confira os créditos restantes no indicador de uso ou use um nível de modelo menor para os subagentes.

### Pedidos de aprovação demais, ou de menos

Altere o nível de permissão da instância (**Manual**, **Auto**, **Dev**) no menu suspenso da instância e ajuste ferramentas específicas em [Configurações](app:openSettingsPageView) → **Permissões de ferramentas**.

### As respostas ficam mais lentas ou menos precisas em um chat longo

A conversa está enchendo o contexto. Clique no indicador de contexto para continuar em um novo chat com um resumo.

### Como desfaço uma alteração?

Abra a barra lateral do chat e clique em **Desfazer** na alteração, no histórico de versões. **Baixar XML** exporta todas as alterações.

### Onde meus dados ficam armazenados?

Localmente, no seu navegador (IndexedDB). Os chats nunca vão para um servidor do AppAgent — apenas para o seu provedor de IA e para a sua instância do ServiceNow. Veja [Armazenamento de dados](#adv-data-storage).

### A interface ou esta página está no idioma errado

Escolha o idioma em [Configurações](app:openSettingsPageView) → **Idioma**. **Auto** segue o idioma do seu navegador.

# Avançado {#advanced}

Esta seção aborda recursos avançados, botões do cabeçalho, formatos de importação/exportação e detalhes técnicos sobre como o AppAgent funciona.

## Botões do cabeçalho do dashboard {#adv-dashboard-header}

O cabeçalho do dashboard contém vários botões de ação:

| Botão | Descrição |
|--------|-------------|
| **Alternar barra lateral** | Mostra ou oculta a navegação da barra lateral esquerda |
| **Abrir em modo independente** | Abre o dashboard em uma nova aba do navegador para visualização independente |
| **Cabeçalhos** | Mostra ou oculta os cabeçalhos dos widgets no dashboard. Quando estão ocultos, os widgets aparecem em uma visualização mais limpa |
| **Regenerar tudo** | Regenera todos os widgets do dashboard usando o agente. Útil para atualizar os dados |
| **Importar** | Importa um dashboard ou widget de um arquivo JSON |
| **Exportar** | Exporta o dashboard inteiro para um arquivo JSON, para backup ou compartilhamento |
| **Adicionar widget** | Abre o editor de widgets para criar um novo widget com a ajuda do agente |

## Botões do cabeçalho dos widgets {#adv-widget-headers}

**Cabeçalhos dos widgets do dashboard** (visíveis quando a opção Cabeçalhos está ativada):

| Botão | Descrição |
|--------|-------------|
| **Alça de arrastar** | O ícone do widget funciona como alça para arrastar e reordenar os widgets |
| **Regenerar** | Pede ao agente para regenerar o conteúdo deste widget |
| **Histórico** | Mostra as versões anteriores deste widget (se houver) |
| **Tela cheia** | Expande o widget para a visualização em tela cheia |
| **Editar** | Abre o editor de widgets para fazer alterações conversando com o agente |
| **Excluir** | Remove o widget do dashboard (com confirmação) |

**Cabeçalhos dos widgets do chat** (widgets exibidos dentro do chat):

| Botão | Descrição |
|--------|-------------|
| **Fixar no Dashboard** | Salva este widget no seu dashboard |
| **Editar código** | Mostra e edita diretamente o código HTML/CSS/JS do widget |
| **Expandir/recolher** | Mostra ou oculta o conteúdo do widget |

## Redimensionar e mover widgets {#adv-resize-move}

**Redimensionar widgets:**

- Cada widget tem uma **alça de redimensionamento** no canto inferior direito
- Clique e arraste a alça para redimensionar o widget
- A largura se ajusta a uma grade de 12 colunas (mínimo de 3 colunas)
- A altura é medida em unidades de 50px (mínimo de 2 unidades = 100px)

**Mover widgets:**

- Ative a opção **Cabeçalhos** para mostrar os cabeçalhos dos widgets
- Clique e arraste o **ícone do widget** (alça de arrastar) para reordenar
- Solte o widget sobre outro widget para trocar as posições
- A ordem dos widgets é salva automaticamente

## Formatos de importação/exportação {#adv-import-export}

**Exportação do dashboard** (`dashboard-YYYY-MM-DD.json`):

```
{
  "type": "appagent-dashboard",
  "version": 1,
  "widgets": [
    {
      "id": "widget_123",
      "title": "Widget Title",
      "html": "<html>...</html>",
      "width": 6,
      "height": 8,
      "order": 0,
      "conversation": [...]
    }
  ]
}
```

**Exportação de um único widget:**

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

**Exportação de um único chat** (`chat-title-YYYY-MM-DD.json`):

```
{
  "exportType": "single_chat",
  "exportDate": "2024-01-15T10:30:00.000Z",
  "chat": {
    "id": "chat_123",
    "title": "Chat Title",
    "messages": [
      {
        "role": "user",
        "content": "User message text"
      },
      {
        "role": "assistant",
        "content": "Agent response text"
      }
    ],
    "createdAt": 1705312200000
  }
}
```

As exportações de chat preservam todo o histórico da conversa, incluindo todas as mensagens do usuário e as respostas do agente. Use o menu suspenso do chat (···) e selecione **Baixar** para exportar chats individuais.

**Exportação de habilidades** (estrutura de pastas):

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Observação:** a importação/exportação de habilidades usa a File System Access API e **só funciona nos navegadores Chrome ou Edge**.
:::

**Exportação de todos os dados** (`appagent-backup-YYYY-MM-DD.json`):

```
{
  "version": 3,
  "exportDate": "2024-01-15T10:30:00.000Z",
  "chats": [...],
  "settings": [...],
  "dashboardWidgets": [...],
  "apiProviders": [...]
}
```

O backup completo inclui todo o histórico de chats, as configurações, as permissões de ferramentas, os widgets do dashboard e as configurações dos provedores de API.

## Estatísticas da API {#adv-api-stats}

Quando ativadas nas Configurações, as estatísticas da API são exibidas após cada resposta do agente:

| Métrica | Descrição |
|--------|-------------|
| **Entrada** | Tokens de entrada — o tamanho do prompt enviado ao agente |
| **Saída** | Tokens de saída — o tamanho da resposta do agente |
| **Total** | Soma dos tokens de entrada + saída |
| **Leitura/escrita de cache** | Tokens lidos do cache de prompt ou gravados nele (reduz o custo) |
| **Raciocínio** | Tokens usados no raciocínio interno (alguns modelos) |
| **Custo** | Custo estimado da chamada de API em USD |
| **Duração** | Tempo gasto na chamada de API |

Em conversas com várias interações, as estatísticas agregadas mostram o total de todas as chamadas.

:::tip
Ative ou desative a exibição das estatísticas da API em [Configurações](app:openSettingsPageView) → Exibição → Mostrar estatísticas da API.
:::

## Edição manual de habilidades {#adv-skills-manual}

As habilidades podem ser criadas e editadas manualmente ou com a ajuda do agente:

**Criar uma habilidade manualmente:**

1. Vá até [Habilidades](app:openSkillsView) e clique em **Nova habilidade**
2. Informe um nome e uma descrição para a habilidade
3. Escreva o conteúdo da habilidade em formato Markdown
4. Clique em **Salvar** para criar a habilidade

**Formato do SKILL.md:**

```
# Skill Name

Description of what this skill does.

## Instructions

Detailed instructions for the Agent...

## Examples

- Example usage 1
- Example usage 2
```

**Editar com o agente:**

1. Clique em **Editar com o agente** em qualquer habilidade
2. Descreva as alterações que você quer
3. O agente vai modificar o conteúdo da habilidade
4. Revise e salve as alterações

**Recursos das habilidades:** as habilidades podem incluir arquivos adicionais (XML, JS, MD) que fornecem contexto ou código extra para o agente.

## Prompt do sistema {#adv-system-prompt}

O prompt do sistema define o comportamento e as capacidades do agente. Você pode personalizá-lo nas [Configurações](app:openSettingsPageView).

**Editar o prompt do sistema:**

1. Vá até Configurações → seção Prompt do sistema
2. Clique em **Editar** para entrar no modo de edição
3. Modifique o modelo conforme necessário
4. Clique em **Salvar** para aplicar as alterações

**Marcadores disponíveis:**

| Placeholder | Descrição |
|-------------|-------------|
| `{{CURRENT_DATE}}` | Data de hoje (dia da semana, mês, dia, ano) |
| `{{ORCHESTRATOR_POLICY}}` | Política de delegação para subagentes — incluída nos chats principais, deixada vazia nos chats de subagentes |
| `{{DISABLED_TOOLS}}` | Lista de ferramentas desativadas |
| `{{TOOL_CATALOG}}` | Catálogo de ferramentas carregadas sob demanda (vazio quando o carregamento sob demanda de ferramentas está desligado) |
| `{{SKILLS_SUMMARY}}` | Conteúdo das habilidades ativas |

Os placeholders são substituídos automaticamente pelos valores reais no envio para a IA. A contagem de tokens mostra tanto o tamanho do modelo quanto o tamanho expandido.

:::tip
Clique em **Reverter para o padrão** para restaurar o prompt do sistema original, se necessário.
:::

## Chamadas de API do agente {#adv-agent-api}

O AppAgent funciona como uma **extensão do Chrome**:

- As chamadas à API de IA vão **diretamente do seu navegador para o provedor de IA** (por exemplo, Anthropic, OpenRouter)
- Elas **não** passam pela sua instância nem por nenhum servidor do AppAgent
- Sua chave de API (ou token OAuth) fica armazenada localmente no seu navegador
- Os dados da conversa são enviados ao provedor de IA para processamento

**Como funciona:**

1. Você digita uma mensagem no chat
2. O AppAgent monta um prompt com as instruções do sistema, as ferramentas e o histórico da conversa
3. O prompt é enviado para a API do provedor de IA
4. A resposta do agente chega ao seu navegador em streaming
5. As chamadas de ferramentas são executadas no seu navegador, usando a sessão da sua instância para as chamadas de API

:::tip
**Privacidade:** sua chave de API e os dados das conversas são tratados no lado do cliente. As chamadas de ferramentas que interagem com a sua instância usam as credenciais da sua sessão atual.
:::

## Endpoints de LLM {#adv-endpoints}

Os modelos se conectam por meio de **endpoints de LLM nomeados** — pares reutilizáveis de `URL + API key`. Assim, você pode apontar o AppAgent para **qualquer API de chat completions compatível com OpenAI**: OpenRouter, um gateway local, um proxy ou o seu próprio modelo hospedado.

1. Em [Configurações → Endpoints de LLM](app:openSettingsPageView), clique em **Adicionar endpoint**
2. Dê a ele um nome, a URL da API e uma chave de API
3. Cada modelo (provedor de API) escolhe um endpoint — atualize uma chave uma única vez, e todos os modelos que a usam são atualizados

:::tip
Os provedores Claude com **OAuth** não usam endpoints — eles se comunicam diretamente com `api.anthropic.com`.
:::

## Entrar com o Claude (OAuth) {#adv-oauth}

Em vez de colar uma chave de API, você pode entrar nos provedores Anthropic usando a sua sessão atual do claude.ai:

1. Em [Configurações → Provedores de API](app:openSettingsPageView), adicione ou edite um provedor Anthropic e ative o **OAuth**
2. A extensão usa o seu login do claude.ai no mesmo perfil do Chrome para se conectar diretamente à Anthropic
3. Sem janela de login extra e sem nenhum servidor do AppAgent no meio

**Requisitos:**

- Você precisa estar conectado ao `claude.ai` no mesmo perfil do Chrome
- Funciona com contas de login único (SSO)

:::tip
Os tokens OAuth são renovados automaticamente. Se o login falhar, abra o `claude.ai` no mesmo perfil e entre novamente.
:::

## Considerações de segurança {#adv-security}

**Armazenamento da chave de API:**

- Sua **chave de API fica armazenada localmente** no IndexedDB do seu navegador
- A chave nunca é enviada para a sua instância nem para nenhum servidor além do provedor de IA
- Limpar os dados do navegador remove a chave de API armazenada

**Sessão e permissões:**

- O agente é executado com a sua **sessão de usuário atual**, herdando seus direitos de acesso e suas funções
- Todas as chamadas de API para a sua instância usam as credenciais da sua sessão
- O agente só pode acessar o que a sua conta de usuário pode acessar

**Ambiente de execução das ferramentas:**

- O **Código no navegador (js_eval)** executa JavaScript em um **sandbox isolado**, com acesso apenas a `executeTool()`
- Os **scripts de widgets** são executados em **iframes isolados**, com acesso apenas a `executeTool()` para chamadas de API
- As **ferramentas de habilidades** são executadas em **sandboxes isolados**, com acesso apenas a `executeTool()`
- Todo acesso à API passa pelo **sistema de permissões** via `executeTool("servicenow_api", {...})`
- O agente interage com as páginas em **abas do navegador** na sua instância do ServiceNow

**Capacidade de modificar registros:**

- A ferramenta **API do ServiceNow** aceita os métodos POST, PATCH, PUT e DELETE, que podem alterar registros
- O agente pode criar e editar registros pelo **navegador integrado** se tiver permissão para as ferramentas de preencher e clicar
- Configure as [Permissões de ferramentas](app:openSettingsPageView) para controlar quais operações exigem aprovação

**Autoaperfeiçoamento:**

- O agente pode **gerenciar as próprias habilidades** — criando, editando e ativando habilidades
- Isso permite que o agente aprenda e se aperfeiçoe com o tempo
- Revise as alterações nas habilidades periodicamente para garantir que estejam de acordo com as suas expectativas

## Armazenamento de dados {#adv-data-storage}

O AppAgent armazena os dados localmente no seu navegador usando o **IndexedDB**:

| Tipo de dado | Armazenamento | Descrição |
|-----------|---------|-------------|
| **Chats** | IndexedDB | Todo o histórico de conversas, mensagens e resultados de ferramentas |
| **Configurações** | IndexedDB | Permissões de ferramentas, chaves de API, preferências de modelo |
| **Widgets do dashboard** | IndexedDB | HTML, títulos, tamanhos e histórico de conversa dos widgets |
| **Habilidades** | IndexedDB | Definições, conteúdo e recursos das habilidades |
| **Provedores de API** | IndexedDB | Configurações e endpoints dos provedores de API personalizados |
| **Estado da interface** | localStorage | Estado da barra lateral, tela atual, posições de rolagem |

**Baixar seus dados:**

1. Vá até [Configurações](app:openSettingsPageView) → Gerenciamento de dados
2. Clique em **Exportar dados**
3. Um arquivo de backup JSON será baixado

**Excluir seus dados:**

1. Vá até [Configurações](app:openSettingsPageView) → Gerenciamento de dados
2. Clique em **Excluir todos os dados**
3. Confirme duas vezes para excluir tudo permanentemente

:::tip
**Importante:** os dados ficam armazenados localmente na extensão. Limpar os dados do navegador, desinstalar a extensão ou usar outro perfil do navegador resulta em armazenamentos de dados separados.
:::

# Sobre {#about}

**Versão:** v__VERSION__

**Licença:** uso privado e comercial. Modificação interna permitida. Distribuição e revenda proibidas. Todos os direitos reservados.

## Changelog {#changelog}

__CHANGELOG__
