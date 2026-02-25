# 🚚 EletraLog TMS - Gestão Logística

O **EletraLog TMS** é uma aplicação web responsiva desenhada para a gestão de alta performance de operações logísticas, com foco em Inbound, Outbound, gestão de pátio e auditoria de fretes. A arquitetura foi construída para eliminar o uso de planilhas, oferecendo controlo em tempo real através de uma Torre de Controlo (Control Tower) e regras de negócio estritas de Gerenciamento de Risco (GR) e Compliance Logístico.

## 🚀 Estado Atual do Projeto

O sistema encontra-se numa fase avançada de MVP (Minimum Viable Product), com os seguintes módulos nucleares 100% funcionais e integrados numa base de dados NoSQL em nuvem.

### 1. Autenticação e Perfis de Acesso (RBAC)
* **Login Seguro:** Interface de entrada (`login.html`) validada com base de dados.
* **Níveis de Permissão:** Controlo de acessos baseado em `MASTER` (Diretoria), `GESTOR`, `USER` (Operador) e `TERCEIRO` (Leitura para portarias/transportadoras).
* **Auto-Bootstrap:** Criação automática do utilizador Master na primeira inicialização da base de dados.

### 2. Módulo de Cadastros (Core Data)
Gestão de entidades com CRUD completo e lógicas de validação avançadas:
* **Transportadoras:** Gestão de parceiros, vigência de ANTT (RNTRC) e auditoria visual de vencimento de apólices de seguros (RCTR-C, RC-DC, RC-V).
* **Equipamentos (Frota):** Registo de veículos com cálculo automático de capacidade (Tara vs PBT), sugestão de tara por categoria, e validação obrigatória de reboques duplos para carretas.
* **Clientes (Matriz Logística):** Gestão multilocais (Pontos de Entrega pelo "Apelido do Local"). Integração direta com **ViaCEP** para preenchimento automático de endereços. Incorpora matriz de restrições de entrega (tipos de veículos aceites, sobreposição de carga, dimensões e janelas de horário).
* **Motoristas:** Foco em GR (Gerenciamento de Risco). Alerta automático de CNH vencida e bloqueio visual de motoristas reprovados na gerenciadora (Status: Liberado, Pendente, Bloqueado).

### 3. Agendamentos (Inbound)
* Gestão visual de ocupação de docas e portaria em slots de 10 minutos.
* Bloqueio de agendamento duplo (conflito de horários).
* Agrupamento por PO (Pedido de Compra) e Nota Fiscal.

### 4. Monitoramento (Torre de Controlo / Control Tower)
* **Dashboard Real-Time:** Contadores de camiões "Agendados", "No Pátio", "Finalizados" e "Ocorrências".
* **Agrupamento Inteligente (Batch):** Slots de tempo do mesmo camião são consolidados numa única linha contínua (ex: 10:00 às 10:50) para visualização fluida.
* **Atraso Automático:** O sistema compara a janela final de agendamento com a hora do relógio local; veículos que ultrapassam a hora caem para o status de "ATRASADO" automaticamente.
* **Apontamentos One-Click:** Atualização ultrarrápida (Chegada, Descarga, Saída) diretamente na tabela.
* **Gestão de Anomalias:** Modal de exceções que obriga o preenchimento da **Causa Raiz** (ex: *No Show*, *Falta de EPI*, *Divergência de PO*) antes de gravar o status de erro, garantindo a fidelidade dos relatórios operacionais.

### 5. Responsividade (Mobile-First UI)
* Interface escura e moderna (`bg-petroleo`, `eletra-aqua`, `eletra-orange`) otimizada para redução da fadiga visual.
* Totalmente responsivo (`max-width: 768px`), transformando-se numa Web App nativa com menu lateral sanduíche deslizante, ideal para operadores de empilhadores, porteiros e conferentes no pátio.

## 🛠️ Stack Tecnológica

* **Front-end:** HTML5, CSS3, Vanilla JavaScript (ES6+).
* **Base de Dados:** Firebase Firestore (NoSQL).
* **Autenticação:** Firebase Auth / Lógica customizada baseada em Hash na coleção `usuarios`.
* **Ícones e Tipografia:** FontAwesome 6 e Google Fonts (Inter).

## ⚙️ Instalação e Execução

Como a aplicação é integralmente baseada em tecnologias Web e Firebase (Serverless), a execução local é extremamente simples.

1. Clone este repositório.
2. Não há necessidade de instalar `node_modules` ou compilar via Webpack.
3. Utilize uma extensão como **Live Server** (no VS Code) ou sirva os ficheiros localmente (`python -m http.server 8000`).
4. Abra o `login.html` no browser.

*Nota: As chaves de configuração do Firebase Cloud Firestore estão inseridas na tag `<script>` do ficheiro `index.html`. Para ambientes de Produção, sugere-se a proteção das chaves de API nas regras de segurança do próprio Firebase Console.*
