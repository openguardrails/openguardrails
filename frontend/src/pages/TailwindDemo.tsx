import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"

export default function TailwindDemo() {
  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold">Tailwind CSS + Shadcn/ui</h1>
          <p className="text-muted-foreground">Vercel 风格设计系统演示</p>
        </div>

        {/* Buttons */}
        <Card>
          <CardHeader>
            <CardTitle>按钮组件</CardTitle>
            <CardDescription>不同风格的扁平化按钮</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-4">
            <Button>默认按钮</Button>
            <Button variant="secondary">次要按钮</Button>
            <Button variant="outline">轮廓按钮</Button>
            <Button variant="ghost">幽灵按钮</Button>
            <Button variant="destructive">危险按钮</Button>
            <Button variant="link">链接按钮</Button>
          </CardContent>
        </Card>

        {/* Form Example */}
        <Card>
          <CardHeader>
            <CardTitle>表单示例</CardTitle>
            <CardDescription>干净简洁的输入框</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">电子邮件</Label>
              <Input type="email" id="email" placeholder="admin@example.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input type="password" id="password" placeholder="••••••••" />
            </div>
            <Button className="w-full">登录</Button>
          </CardContent>
        </Card>

        {/* Badges */}
        <Card>
          <CardHeader>
            <CardTitle>徽章组件</CardTitle>
            <CardDescription>替代 Ant Design Tag</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Badge>默认</Badge>
            <Badge variant="secondary">次要</Badge>
            <Badge variant="outline">轮廓</Badge>
            <Badge variant="destructive">危险</Badge>
            <Badge variant="success">成功</Badge>
            <Badge variant="warning">警告</Badge>
            <Badge variant="danger">错误</Badge>
          </CardContent>
        </Card>

        {/* Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="hover:shadow-md transition-shadow">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-gray-600">
                总请求数
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">12,345</div>
            </CardContent>
          </Card>

          <Card className="hover:shadow-md transition-shadow">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-gray-600">
                高风险
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-red-600">23</div>
            </CardContent>
          </Card>

          <Card className="hover:shadow-md transition-shadow">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-gray-600">
                通过率
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-green-600">99.8%</div>
            </CardContent>
          </Card>
        </div>

        {/* Typography */}
        <Card>
          <CardHeader>
            <CardTitle>排版系统</CardTitle>
            <CardDescription>Inter 字体,清晰易读</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h1 className="text-4xl font-bold">Heading 1</h1>
              <h2 className="text-3xl font-semibold">Heading 2</h2>
              <h3 className="text-2xl font-medium">Heading 3</h3>
              <h4 className="text-xl">Heading 4</h4>
            </div>
            <div className="space-y-2">
              <p className="text-base">
                这是正常文本。使用 Inter 字体,具有出色的可读性。
              </p>
              <p className="text-sm text-muted-foreground">
                这是次要文本,颜色较浅。
              </p>
              <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                代码文本样式
              </code>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
