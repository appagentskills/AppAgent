# Introdução {#getting-started}

O AppAgent é um agente de IA para o ServiceNow que funciona como extensão do Chrome. Descreva o que precisa em linguagem simples e o agente consulta dados, edita registos, cria aplicações e widgets, testa páginas no seu navegador e apresenta-lhe os resultados.

:::tip
**Início rápido:** configure um modelo, abra um separador na sua instância do ServiceNow e, em seguida, escreva um pedido na conversa e prima <kbd>Enter</kbd>.
:::

## Configurar um modelo {#guide-setup}

1. Abra as [Definições](app:openSettingsPageView) e aceda a **Fornecedores de API**
2. Adicione um fornecedor (Anthropic, OpenRouter ou uma API personalizada compatível com OpenAI) com a sua chave de API — ou ative o **OAuth** num fornecedor Anthropic para iniciar sessão com a sua conta Claude
3. Escolha o modelo a utilizar em **Modelo do agente**

A sua chave de API fica guardada apenas no seu navegador. As chamadas de IA vão diretamente do seu navegador para o fornecedor.

## Ligar as suas instâncias {#guide-instances}

O AppAgent **deteta automaticamente todas as instâncias do ServiceNow** que tem abertas no mesmo perfil do Chrome — não é necessário introduzir nenhuma cadeia de ligação. Inicie sessão numa instância num separador normal e o agente pode trabalhar nela com as funções e os direitos de acesso do seu utilizador. Peça *"lista as instâncias"* para ver todas as instâncias detetadas, as suas funções e o estado da ligação.

Cada instância tem um **nível de permissão**, escolhido na lista pendente da instância:

- **Manual** — Aprova cada operação de escrita (criar, atualizar, eliminar, preencher formulários)
- **Automático** — O agente decide sobre as operações de escrita sem perguntar
- **Dev** — Sem qualquer aprovação: todas as chamadas de ferramentas nesta instância são executadas sem perguntar. Utilize-o apenas em instâncias de desenvolvimento

As leituras são sempre permitidas. Consulte [Permissões das ferramentas](#feature-permissions) para um controlo mais detalhado.

## Iniciar uma conversa {#guide-chat}

1. Clique em **Nova conversa** na barra lateral [Iniciar nova conversa →](app:startNewChat)
2. Escreva o seu pedido, por exemplo *"Mostra-me todos os incidentes criados hoje"*
3. Prima <kbd>Enter</kbd> para enviar
4. Acompanhe o trabalho do agente: cada chamada de ferramenta aparece na conversa e surgem pedidos de aprovação quando um passo precisa do seu consentimento

Pode continuar a escrever enquanto o agente está a trabalhar: enviar uma nova mensagem interrompe o passo atual e **Pausar** para a execução.

## Anexar imagens e ficheiros {#guide-images}

1. Clique no botão **Anexar ficheiro** na área de introdução para adicionar uma imagem, um PDF, um CSV ou um ficheiro de texto
2. Em alternativa, cole uma imagem da área de transferência ou arraste-a e largue-a na conversa
3. Escreva a sua pergunta sobre o anexo

:::tip
Anexe capturas de ecrã de erros, maquetas de interface ou dados exportados para que o agente veja exatamente o mesmo que o utilizador.
:::

# Funcionalidades principais {#features}

## Conversa {#page-chat}

A vista principal da conversa. [Iniciar nova conversa →](app:startNewChat)

- **Área de mensagens** — A conversa, incluindo as chamadas de ferramentas e os respetivos resultados
- **Caixa de introdução** — Escreva mensagens, anexe ficheiros e envie enquanto o agente está a trabalhar para o interromper
- **Pausar / Continuar / Tentar novamente** — Pare o agente, retome-o ou repita o último passo
- **Indicador de contexto** — Mostra o nível de preenchimento da conversa; clique nele para resumir numa nova conversa
- **Cartões de resposta** — Um cartão **Resumo** (TL;DR) e um cartão **Ligações** (registos, PRs, documentos) podem aparecer por baixo de uma resposta
- **Cabeçalho da conversa** — Mude o nome ou afixe a conversa, ou abra o AppAgent num separador completo do navegador com **Expandir para página inteira**

## Controlo do navegador {#feature-browser}

O agente pode abrir e controlar separadores do navegador na sua instância para ver e testar páginas:

- **Navegar, clicar, preencher e selecionar** — Eventos realistas, para que os formulários e os campos de preenchimento automático se comportem como se estivesse a escrever
- **Aguardar** — Aguarda por um elemento, um texto ou um URL em vez de adivinhar tempos de espera
- **Capturas de ecrã** — Captura a página, um widget ou um único elemento para verificações visuais
- **Inspecionar** — Lê propriedades de elementos, estilos, erros da consola e pedidos de rede
- **Representar** — Testa como outro utilizador e depois volta ao seu

## Editar registos e histórico de versões {#feature-history}

Todas as alterações que o agente faz na sua instância ficam registadas na barra lateral da conversa:

- **Anular** — Reverte uma alteração individual
- **Refazer** — Repõe uma alteração revertida
- **Transferir XML** — Exporta todas as alterações, por exemplo para as mover para outra instância

## Subagentes {#feature-subagents}

Para trabalho pesado ou em paralelo, o agente pode iniciar **subagentes**: trabalhadores em segundo plano que são executados na sua própria conversa e contexto e depois comunicam um resultado breve à conversa principal.

- **Níveis de modelo** — Cada subagente é executado num nível **pequeno**, **médio** ou **grande**, ou **igual** para utilizar o modelo da conversa principal. Associe os níveis a modelos em [Definições](app:openSettingsPageView) → **Níveis de modelo dos subagentes**
- **Barra de trabalhadores** — Os subagentes em execução aparecem como etiquetas em tempo real por cima da caixa de introdução; abra um para acompanhar o progresso ou ler a transcrição
- **Grupo** — O número de subagentes em simultâneo é limitado; os restantes aguardam numa fila

## Painel e widgets {#page-dashboard}

Um painel de widgets interativos gerados pelo agente. [Abrir painel →](app:openDashboardView)

1. Clique em **Adicionar widget**
2. Descreva o que pretende, por exemplo *"Um gráfico com os incidentes abertos por prioridade"*
3. O agente cria o widget; peça alterações ou clique em **Regenerar** a qualquer momento

Os widgets podem obter dados em tempo real da sua instância, pelo que se mantêm sempre atualizados. Pode arrastá-los, redimensioná-los, importá-los e exportá-los (consulte [Avançado](#advanced)). Os widgets que o agente apresenta diretamente numa conversa podem ser guardados com **Afixar no painel**.

## Documentos inteligentes {#page-documents}

Os **Documentos inteligentes** são documentos Markdown persistentes e com controlo de versões que o agente escreve e atualiza — planos, relatórios, especificações, conclusões. São apresentados diretamente na conversa, guardam todas as versões e podem ser editados diretamente por si. Abra-os a partir de **Documentos** na barra lateral. [Abrir documentos →](app:openDocumentsView)

## Competências {#page-skills}

As competências dão ao agente conhecimentos e ferramentas adicionais. [Abrir competências →](app:openSkillsView)

- **Ativar / Desativar** — Ligue ou desligue competências; desative as que não precisa para manter as respostas focadas
- **Nova competência** — Escreva a sua própria competência em Markdown ou utilize **Editar com o agente**
- **Importar / Exportar** — Partilhe competências como pastas
- **Ações de competências** — Algumas competências adicionam botões de um clique na página inicial que iniciam um fluxo de trabalho predefinido

Uma competência pode fornecer **conhecimento** (instruções, boas práticas) e **ferramentas personalizadas** (funções JavaScript executadas num ambiente isolado).

## Espaço de trabalho e GitHub {#feature-workspace}

Cada conversa tem um **espaço de trabalho** — uma área de ficheiros onde o agente pode ler, escrever, editar e comparar ficheiros.

- **GitHub** — Ligue uma conta GitHub nas [Definições](app:openSettingsPageView) para clonar repositórios para um espaço de trabalho. O agente pode criar ramos, enviar commits e abrir pull requests a partir da conversa
- **Pull requests** — Os PRs abertos a partir de uma conversa são listados na barra lateral da conversa, com um botão **Integrar**
- **Proteção entre conversas** — Cada ficheiro memoriza que conversa o alterou, para que duas conversas a trabalhar em paralelo não substituam silenciosamente o trabalho uma da outra
- **Sincronização automática** — Os espaços de trabalho clonados são sincronizados com o GitHub quando navega, muda de conversa ou regressa ao separador

## Barra lateral da conversa {#feature-sidebar}

A barra lateral direita reúne tudo o que a conversa atual produziu:

- **Pull requests** — Título, ramo de destino e um botão **Integrar**
- **Ficheiros do espaço de trabalho** — Abra um ficheiro para o ver, consultar as diferenças ou percorrer versões anteriores
- **Histórico de versões** — Alterações na instância com **Anular**, **Refazer** e **Transferir XML**
- **Trabalhadores** — Subagentes em execução e concluídos, com contadores de chamadas de ferramentas, ficheiros editados e PRs abertos

## Ações e progresso em tempo real {#feature-actions}

As tarefas longas mostram o progresso em tempo real em vez de ficarem em silêncio:

- **Cartão de progresso** — Um único cartão com um estado colorido (em execução, bloqueado, concluído, erro) e uma lista de passos
- **Botões de ação** — Botões de um clique que iniciam fluxos de trabalho de seguimento
- **Indicador de execução** — A lista de conversas assinala as conversas em que o agente está a trabalhar
- **Notificação "O agente terminou"** — Se mudar de separador ou de janela durante uma execução, uma notificação no ambiente de trabalho avisa-o quando o agente terminar

## Conversas ativas e tarefas {#feature-jobs}

O indicador de tarefas no cabeçalho abre uma vista em tempo real das suas conversas e do trabalho em segundo plano:

- **Conversas ativas** — Conversas em execução e conversas com resultados por ler (apresentadas a **negrito**), cada uma com um anel de utilização do contexto
- **Subagentes** — Listados sob a respetiva conversa principal; abra um para ler a transcrição
- **Expandir** — Abre a lista num painel maior, com uma disposição em colunas ou em secções

## Permissões das ferramentas {#feature-permissions}

Além do nível de permissão por instância (**Manual**, **Automático**, **Dev**), cada ferramenta tem a sua própria definição em [Definições](app:openSettingsPageView) → **Permissões das ferramentas**:

- **Permitir** — A ferramenta é sempre executada sem perguntar
- **Automático** — A ferramenta é executada sem perguntar, a menos que o agente assinale que uma chamada precisa da sua confirmação
- **Perguntar** — Recebe um pedido de aprovação antes de cada chamada
- **Desativado** — O agente não pode utilizar a ferramenta

Algumas ferramentas têm controlos mais detalhados: a API do ServiceNow por método HTTP (GET, POST, PUT, PATCH, DELETE), o controlo do navegador por ação (navegar, clicar, preencher, representar…) e a gestão de competências por ação. As caixas de diálogo de confirmação têm cores consoante o risco: **azul** (rotina), **laranja** (cuidado), **vermelho** (destrutivo).

:::tip
Mantenha o DELETE e outras operações destrutivas em **Perguntar** e utilize **Dev** apenas em instâncias de desenvolvimento.
:::

## Ferramentas do agente {#feature-tools}

As principais ferramentas que o agente utiliza:

| Ferramenta | O que faz |
|------|--------------|
| **API do ServiceNow** (`servicenow_api`) | Ler, criar, atualizar e eliminar registos |
| **Script em segundo plano** (`servicenow_run_script`) | Executar um script do lado do servidor na instância (requer a função admin) |
| **Edição de scripts** (`servicenow_diff_edit`) | Alterar scripts com edições precisas de pesquisa e substituição |
| **Controlo do navegador** (`iframe_tool`) | Navegar, clicar, preencher, inspecionar e representar utilizadores nos separadores do navegador |
| **Código do navegador** (`js_eval`) | Executar JavaScript num ambiente isolado que pode chamar outras ferramentas |
| **Capturas de ecrã** (`take_screenshot`) | Capturar a página, um widget ou um elemento |
| **Widgets e cartões** (`html_widget`, `display`) | Mostrar widgets interativos, tabelas, cartões e cronologias na conversa |
| **Documentos inteligentes** (`document`) | Criar e atualizar documentos Markdown persistentes |
| **Perguntar ao utilizador** (`prompt_user`) | Pedir-lhe informações através de um formulário na conversa |
| **Subagentes** (`spawn_sub_agent`) | Delegar trabalho em trabalhadores em segundo plano |
| **Espaço de trabalho** (`workspace`) | Trabalhar com ficheiros e repositórios GitHub |
| **Obtenção web** (`web_fetch`) | Ler páginas da web pública |
| **Competências** (`get_skill`, `manage_skill`) | Ler e gerir competências |

Abra [Definições](app:openSettingsPageView) → **Permissões das ferramentas** para ver todas as ferramentas, a respetiva origem e a permissão.

## Cache de conteúdos grandes {#feature-caching}

Quando o resultado de uma ferramenta é demasiado grande para a conversa (mais de 4K tokens por predefinição), o AppAgent guarda-o em cache. O agente recebe uma estrutura e depois lê, pesquisa ou percorre apenas as partes de que precisa. Isto mantém as conversas rápidas e focadas. Altere o limiar (de 1K a 100K tokens) em [Definições](app:openSettingsPageView) → **Cache de conteúdos grandes**.

## Indicador de contexto {#feature-saturation}

O **indicador de contexto** junto à caixa de introdução mostra o nível de preenchimento da conversa. Acima de 50%, é pedido ao agente que conclua e passe o trabalho pesado restante para subagentes; aos 100%, para e apresenta um relatório. Clique no indicador a qualquer momento para resumir a conversa numa conversa nova.

## Utilização e limites de pedidos {#feature-usage}

- **Indicador de utilização** — O cabeçalho mostra a sua utilização da API e os limites restantes; clique nele para ver os detalhes
- **Novas tentativas automáticas** — Quando o fornecedor está a limitar pedidos ou sobrecarregado (HTTP 429 / 529), o AppAgent aguarda e tenta novamente de forma automática, mostrando uma contagem decrescente na conversa
- **Sem créditos** — Quando um 429 significa, na verdade, que os seus créditos se esgotaram, a conversa indica-o claramente

## Idiomas {#feature-languages}

A interface está disponível em inglês e em mais 24 idiomas: alemão, árabe, checo, chinês (simplificado, tradicional), coreano, dinamarquês, espanhol, finlandês, francês (França, Canadá), hebraico, húngaro, italiano, japonês, neerlandês, norueguês, polaco, português (Brasil, Portugal), russo, sueco, tailandês e turco.

Escolha um em [Definições](app:openSettingsPageView) → **Idioma** ou no menu de definições rápidas no cabeçalho. **Automático** segue o idioma do seu navegador e recorre ao inglês quando necessário. A alteração é aplicada de imediato, sem recarregar.

- **Da direita para a esquerda** — O árabe e o hebraico utilizam uma disposição da direita para a esquerda
- **Formatos locais** — As datas, as horas e os números seguem o seu idioma
- **Respostas do agente** — O agente responde no idioma escolhido, a menos que escreva noutro. Os nomes de código, tabelas e campos mantêm-se inalterados
- **Esta página de ajuda** — Apresentada no seu idioma; o registo de alterações mantém-se em inglês

# Páginas e definições {#pages}

## Definições {#page-settings}

[Abrir definições →](app:openSettingsPageView)

- **Modelo do agente** — O modelo que o agente utiliza
- **Fornecedores de API** — Anthropic, OpenRouter ou fornecedores personalizados, com uma chave de API ou OAuth
- **Endpoints de LLM** — Pares `URL + API key` com nome para qualquer API compatível com OpenAI
- **Níveis de modelo dos subagentes** — Associe os níveis pequeno, médio e grande a modelos, ou **Igual**
- **Esforço de raciocínio, máximo de tokens e orçamento de raciocínio** — Ajuste a profundidade e a extensão das respostas
- **Janela de contexto** — O tamanho do contexto utilizado pelo indicador de contexto
- **Apresentação** — Estatísticas da API, modo compacto, manter o ecrã ligado
- **Idioma** — Idioma da interface, ou **Automático**
- **Hooks** — Títulos automáticos das conversas, notificações "O agente terminou" e outras automatizações
- **Cache de conteúdos grandes** — Quando os resultados grandes são guardados em cache
- **Permissões das ferramentas** — O que é executado automaticamente, pede confirmação primeiro ou está desativado
- **GitHub** — Ligue uma conta GitHub e faça a gestão dos repositórios clonados
- **Prompt de sistema** — Personalize as instruções do agente
- **Gestão de dados** — Exporte, importe ou elimine os seus dados

## Histórico {#page-history}

Todas as suas conversas. [Abrir histórico →](app:openHistoryView)

- **Pesquisar** — Encontre conversas por título, conteúdo, ferramentas utilizadas ou widgets
- **Afixar** — Mantenha as conversas importantes no topo
- **Exportar** — Transfira uma conversa ou todo o seu histórico
- **Estatísticas** — Número de conversas, conversas afixadas e custo total

## Ajuda {#page-docs}

Esta página. [Abrir ajuda →](app:openDocsView)

- **Pesquisar** — Filtre os tópicos de ajuda a partir da caixa de pesquisa na barra de ferramentas
- **Índice** — Salte para uma secção a partir do índice
- **Transferir** — Guarde a documentação como ficheiro Markdown

# Sugestões e atalhos de teclado {#tips}

| Ação | Como |
|--------|-----|
| Enviar mensagem | <kbd>Enter</kbd> |
| Nova linha | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Pesquisar conversas | <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> no Mac) |
| Fechar uma caixa de diálogo ou um menu | <kbd>Esc</kbd> |
| Voltar | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Anexar uma imagem | Cole-a ou arraste-a e largue-a na conversa |
| Recomeçar com um resumo | Clique no indicador de contexto |
| Interromper o agente | Envie uma nova mensagem ou clique em **Pausar** |

:::tip
**Seja específico.** Em vez de *"corrige isto"*, diga *"corrige o erro de referência nula na linha 42 do script include MyUtils"*. Indique a tabela, o registo ou a página sempre que possível.
:::

- **Um objetivo por conversa** — Inicie uma nova conversa para uma tarefa não relacionada; o agente mantém-se mais rápido e preciso
- **Deixe-o testar** — Peça ao agente que abra a página e verifique a sua própria alteração com uma captura de ecrã
- **Utilize competências** — Ative uma competência adequada à sua tarefa (por exemplo, testes ou auditorias) antes de começar

# Resolução de problemas e perguntas frequentes {#faq}

### O agente não vê a minha instância

Abra a instância num separador do mesmo perfil do Chrome e confirme que tem sessão iniciada; depois, peça *"lista as instâncias"*. Se continuar a não aparecer, recarregue o separador da instância.

### Recebo um erro de API ou de autenticação

Verifique o seu fornecedor em [Definições](app:openSettingsPageView) → **Fornecedores de API**: a chave de API, o endpoint selecionado e o nome do modelo. Para o OAuth, inicie novamente sessão em claude.ai no mesmo perfil do Chrome.

### O agente indica que está a ser limitado

O AppAgent tenta novamente de forma automática e mostra uma contagem decrescente. Se continuar a acontecer, verifique os créditos restantes no indicador de utilização ou utilize um nível de modelo mais pequeno para os subagentes.

### Demasiados pedidos de aprovação, ou poucos

Altere o nível de permissão da instância (**Manual**, **Automático**, **Dev**) na lista pendente da instância e ajuste ferramentas individuais em [Definições](app:openSettingsPageView) → **Permissões das ferramentas**.

### As respostas ficam mais lentas ou menos precisas numa conversa longa

A conversa está a encher o contexto. Clique no indicador de contexto para continuar numa conversa nova com um resumo.

### Como anulo uma alteração?

Abra a barra lateral da conversa e clique em **Anular** na alteração, no histórico de versões. **Transferir XML** exporta todas as alterações.

### Onde ficam guardados os meus dados?

Localmente, no seu navegador (IndexedDB). As conversas nunca vão para um servidor do AppAgent — apenas para o seu fornecedor de IA e para a sua instância do ServiceNow. Consulte [Armazenamento de dados](#adv-data-storage).

### A interface ou esta página está no idioma errado

Escolha o idioma em [Definições](app:openSettingsPageView) → **Idioma**. **Automático** segue o idioma do seu navegador.

# Avançado {#advanced}

Esta secção aborda funcionalidades avançadas, botões do cabeçalho, formatos de importação/exportação e detalhes técnicos sobre o funcionamento do AppAgent.

## Botões do cabeçalho do painel {#adv-dashboard-header}

O cabeçalho do painel contém vários botões de ação:

| Botão | Descrição |
|--------|-------------|
| **Alternar barra lateral** | Mostra ou oculta a navegação da barra lateral esquerda |
| **Abrir em separado** | Abre o painel num novo separador do navegador para visualização autónoma |
| **Cabeçalhos** | Alterna a visibilidade dos cabeçalhos dos widgets no painel. Quando ocultos, os widgets são apresentados numa vista mais limpa |
| **Regenerar tudo** | Regenera todos os widgets do painel com o agente. Útil para atualizar os dados |
| **Importar** | Importa um painel ou um widget a partir de um ficheiro JSON |
| **Exportar** | Exporta todo o painel para um ficheiro JSON, para cópia de segurança ou partilha |
| **Adicionar widget** | Abre o editor de widgets para criar um novo widget com a ajuda do agente |

## Botões do cabeçalho dos widgets {#adv-widget-headers}

**Cabeçalhos dos widgets do painel** (visíveis quando a opção Cabeçalhos está ativada):

| Botão | Descrição |
|--------|-------------|
| **Pega de arrastamento** | O ícone do widget funciona como pega para arrastar e reordenar os widgets |
| **Regenerar** | Pede ao agente que regenere o conteúdo deste widget |
| **Histórico** | Mostra as versões anteriores deste widget (se existirem) |
| **Ecrã inteiro** | Expande o widget para visualização em ecrã inteiro |
| **Editar** | Abre o editor de widgets para o modificar através da conversa com o agente |
| **Eliminar** | Remove o widget do painel (com confirmação) |

**Cabeçalhos dos widgets da conversa** (widgets apresentados na conversa):

| Botão | Descrição |
|--------|-------------|
| **Afixar no painel** | Guarda este widget no seu painel |
| **Editar código** | Permite ver e editar diretamente o código HTML/CSS/JS do widget |
| **Expandir/recolher** | Alterna a visibilidade do conteúdo do widget |

## Redimensionar e mover widgets {#adv-resize-move}

**Redimensionar widgets:**

- Cada widget tem uma **pega de redimensionamento** no canto inferior direito
- Clique na pega e arraste-a para redimensionar o widget
- A largura ajusta-se a uma grelha de 12 colunas (mínimo de 3 colunas)
- A altura é medida em unidades de 50px (mínimo de 2 unidades = 100px)

**Mover widgets:**

- Ative a opção **Cabeçalhos** para mostrar os cabeçalhos dos widgets
- Clique no **ícone do widget** (pega de arrastamento) e arraste-o para reordenar
- Largue o widget sobre outro widget para trocar as posições
- A ordem dos widgets é guardada automaticamente

## Formatos de importação/exportação {#adv-import-export}

**Exportação do painel** (`dashboard-YYYY-MM-DD.json`):

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

**Exportação de uma única conversa** (`chat-title-YYYY-MM-DD.json`):

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

As exportações de conversas preservam todo o histórico da conversa, incluindo todas as mensagens do utilizador e as respostas do agente. Utilize o menu pendente da conversa (···) e selecione **Transferir** para exportar conversas individuais.

**Exportação de competências** (estrutura de pastas):

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Nota:** a importação/exportação de competências utiliza a File System Access API e **só funciona nos navegadores Chrome ou Edge**.
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

A cópia de segurança completa inclui todo o histórico de conversas, as definições, as permissões das ferramentas, os widgets do painel e as configurações dos fornecedores de API.

## Estatísticas da API {#adv-api-stats}

Quando ativadas nas Definições, as estatísticas da API são apresentadas após cada resposta do agente:

| Métrica | Descrição |
|--------|-------------|
| **In** | Tokens de entrada — o tamanho do prompt enviado ao agente |
| **Out** | Tokens de saída — o tamanho da resposta do agente |
| **Total** | Soma dos tokens de entrada + saída |
| **Cache Read/Write** | Tokens lidos da cache de prompts ou nela escritos (reduz o custo) |
| **Reasoning** | Tokens utilizados no raciocínio interno (alguns modelos) |
| **Cost** | Custo estimado da chamada à API em USD |
| **Duration** | Tempo que a chamada à API demorou |

Nas conversas com várias interações, as estatísticas agregadas mostram o total de todas as chamadas.

:::tip
Ative ou desative a apresentação das estatísticas da API em [Definições](app:openSettingsPageView) → Apresentação → Mostrar estatísticas da API.
:::

## Edição manual de competências {#adv-skills-manual}

As competências podem ser criadas e editadas manualmente ou com a ajuda do agente:

**Criar uma competência manualmente:**

1. Aceda a [Competências](app:openSkillsView) e clique em **Nova competência**
2. Introduza um nome e uma descrição para a competência
3. Escreva o conteúdo da competência em formato Markdown
4. Clique em **Guardar** para criar a competência

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

1. Clique em **Editar com o agente** em qualquer competência
2. Descreva as alterações que pretende
3. O agente modifica o conteúdo da competência
4. Reveja e guarde as alterações

**Recursos das competências:** as competências podem incluir ficheiros adicionais (XML, JS, MD) que fornecem contexto ou código extra ao agente.

## Prompt de sistema {#adv-system-prompt}

O prompt de sistema define o comportamento e as capacidades do agente. Pode personalizá-lo nas [Definições](app:openSettingsPageView).

**Editar o prompt de sistema:**

1. Aceda a Definições → secção Prompt de sistema
2. Clique em **Editar** para mudar para o modo de edição
3. Modifique o modelo conforme necessário
4. Clique em **Guardar** para aplicar as alterações

**Marcadores disponíveis:**

| Marcador de posição | Descrição |
|-------------|-------------|
| `{{CURRENT_DATE}}` | A data de hoje (dia da semana, mês, dia, ano) |
| `{{ORCHESTRATOR_POLICY}}` | Política de delegação em subagentes — incluída nas conversas principais, deixada vazia nas conversas de subagentes |
| `{{DISABLED_TOOLS}}` | Lista de ferramentas desativadas |
| `{{TOOL_CATALOG}}` | Catálogo de ferramentas diferidas (vazio quando o carregamento diferido de ferramentas está desativado) |
| `{{SKILLS_SUMMARY}}` | Conteúdo das competências ativas |

Os marcadores de posição são substituídos automaticamente pelos valores reais no envio para a IA. A contagem de tokens mostra tanto o tamanho do modelo como o tamanho expandido.

:::tip
Clique em **Reverter para a predefinição** para repor o prompt de sistema original, se necessário.
:::

## Chamadas à API do agente {#adv-agent-api}

O AppAgent funciona como uma **extensão do Chrome**:

- As chamadas à API de IA vão **diretamente do seu navegador para o fornecedor de IA** (por exemplo, Anthropic, OpenRouter)
- **Não** passam pela sua instância nem por qualquer servidor do AppAgent
- A sua chave de API (ou token OAuth) fica guardada localmente no seu navegador
- Os dados da conversa são enviados ao fornecedor de IA para processamento

**Como funciona:**

1. Escreve uma mensagem na conversa
2. O AppAgent cria um prompt com as instruções de sistema, as ferramentas e o histórico da conversa
3. O prompt é enviado para a API do fornecedor de IA
4. A resposta do agente é transmitida de volta para o seu navegador
5. As chamadas de ferramentas são executadas no seu navegador, utilizando a sessão da sua instância para as chamadas à API

:::tip
**Privacidade:** a sua chave de API e os dados da conversa são tratados do lado do cliente. As chamadas de ferramentas que interagem com a sua instância utilizam as credenciais da sua sessão existente.
:::

## Endpoints de LLM {#adv-endpoints}

Os modelos ligam-se através de **endpoints de LLM com nome** — pares `URL + API key` reutilizáveis. Isto permite apontar o AppAgent para **qualquer API de chat completions compatível com OpenAI**: OpenRouter, um gateway local, um proxy ou o seu próprio modelo alojado.

1. Em [Definições → Endpoints de LLM](app:openSettingsPageView), clique em **Adicionar endpoint**
2. Atribua-lhe um nome, o URL da API e uma chave de API
3. Cada modelo (fornecedor de API) escolhe um endpoint — atualize uma chave uma vez e todos os modelos que a utilizam ficam atualizados

:::tip
Os fornecedores Claude com **OAuth** não utilizam endpoints — comunicam diretamente com `api.anthropic.com`.
:::

## Iniciar sessão com o Claude (OAuth) {#adv-oauth}

Em vez de colar uma chave de API, pode iniciar sessão nos fornecedores Anthropic com a sua sessão existente em claude.ai:

1. Em [Definições → Fornecedores de API](app:openSettingsPageView), adicione ou edite um fornecedor Anthropic e ative o **OAuth**
2. A extensão utiliza a sua sessão de claude.ai no mesmo perfil do Chrome para se ligar diretamente à Anthropic
3. Sem janela de início de sessão adicional e sem nenhum servidor do AppAgent pelo meio

**Requisitos:**

- Tem de ter sessão iniciada em `claude.ai` no mesmo perfil do Chrome
- Funciona com contas de início de sessão único (SSO)

:::tip
Os tokens OAuth são renovados automaticamente. Se o início de sessão falhar, abra `claude.ai` no mesmo perfil e inicie sessão novamente.
:::

## Considerações de segurança {#adv-security}

**Armazenamento da chave de API:**

- A sua **chave de API fica guardada localmente** na IndexedDB do seu navegador
- A chave nunca é enviada para a sua instância nem para qualquer servidor além do fornecedor de IA
- Limpar os dados do navegador remove a chave de API guardada

**Sessão e permissões:**

- O agente é executado com a sua **sessão de utilizador atual**, herdando os seus direitos de acesso e funções
- Todas as chamadas à API da sua instância utilizam as credenciais da sua sessão
- O agente só consegue aceder ao que a sua conta de utilizador consegue aceder

**Ambiente de execução das ferramentas:**

- O **código do navegador (js_eval)** executa JavaScript num **ambiente isolado** com acesso apenas a `executeTool()`
- Os **scripts dos widgets** são executados em **iframes isolados** com acesso apenas a `executeTool()` para as chamadas à API
- As **ferramentas das competências** são executadas em **ambientes isolados** com acesso apenas a `executeTool()`
- Todo o acesso à API passa pelo **sistema de permissões** através de `executeTool("servicenow_api", {...})`
- O agente interage com as páginas em **separadores do navegador** na sua instância do ServiceNow

**Capacidade de modificar registos:**

- A ferramenta **API do ServiceNow** suporta os métodos POST, PATCH, PUT e DELETE, que podem alterar registos
- O agente pode criar e editar registos através do **navegador integrado**, se tiver permissões para as ferramentas de preenchimento e clique
- Configure as [Permissões das ferramentas](app:openSettingsPageView) para controlar que operações requerem aprovação

**Autoaperfeiçoamento:**

- O agente pode **gerir as suas próprias competências** — criar, editar e ativar competências
- Isto permite ao agente aprender e aperfeiçoar-se ao longo do tempo
- Reveja periodicamente as alterações às competências para garantir que correspondem às suas expectativas

## Armazenamento de dados {#adv-data-storage}

O AppAgent guarda os dados localmente no seu navegador com a **IndexedDB**:

| Tipo de dados | Armazenamento | Descrição |
|-----------|---------|-------------|
| **Conversas** | IndexedDB | Todo o histórico de conversas, mensagens e resultados de ferramentas |
| **Definições** | IndexedDB | Permissões das ferramentas, chaves de API, preferências de modelo |
| **Widgets do painel** | IndexedDB | HTML dos widgets, títulos, tamanhos e histórico da conversa |
| **Competências** | IndexedDB | Definições, conteúdo e recursos das competências |
| **Fornecedores de API** | IndexedDB | Configurações e endpoints dos fornecedores de API personalizados |
| **Estado da interface** | localStorage | Estado da barra lateral, vista atual, posições de deslocamento |

**Transferir os seus dados:**

1. Aceda a [Definições](app:openSettingsPageView) → Gestão de dados
2. Clique em **Exportar dados**
3. É transferido um ficheiro JSON de cópia de segurança

**Eliminar os seus dados:**

1. Aceda a [Definições](app:openSettingsPageView) → Gestão de dados
2. Clique em **Eliminar todos os dados**
3. Confirme duas vezes para eliminar tudo permanentemente

:::tip
**Importante:** os dados são guardados localmente na extensão. Limpar os dados do navegador, desinstalar a extensão ou utilizar outro perfil do navegador resulta em armazenamentos de dados separados.
:::

# Acerca de {#about}

**Versão:** v__VERSION__

**Licença:** Utilização privada e comercial. Modificação interna permitida. Distribuição e revenda proibidas. Todos os direitos reservados.

## Registo de alterações {#changelog}

__CHANGELOG__
